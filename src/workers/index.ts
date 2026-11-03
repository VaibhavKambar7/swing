import "../lib/config/load-env";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { getEnv } from "../lib/config/env";
import { closeDatabase, getDatabase } from "../lib/db";
import { checkDatabase } from "../lib/health";
import { runJobOnce } from "../lib/jobs/runner";
import { createJobHandlers } from "../lib/jobs/handlers";
import { loadMarketCalendar } from "../lib/market/load-calendar";
import { CalendarError } from "../lib/market/calendar";
import { scheduleAnnouncementRun } from "../lib/market/scheduler";
import { getJobStatus, publicJobKind } from "../lib/jobs/status";

const env = getEnv();
const startedAt = new Date().toISOString();
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let activeHeartbeat: Promise<void> | undefined;
let databaseUp = false;
let lastCheckedAt = 0;
const workerId = randomUUID();
const stopJobs = new AbortController();
let jobTimer: NodeJS.Timeout | undefined;
let activeJob: Promise<void> | undefined;
let jobsUp = false;
let schedulerTimer: NodeJS.Timeout | undefined;
let activeScheduler: Promise<void> | undefined;
let schedulerUp = !env.WORKER_SCHEDULER_ENABLED;
let lastJobPollAt = 0;
let activeJobInfo: { jobId: string; kind: string; attempt: number } | null = null;
let lastSchedulerTickAt = 0;
let schedulerErrorCode: string | null = null;

function runtimeStatus() {
  const now = Date.now();
  const databaseReady = databaseUp && now - lastCheckedAt < env.WORKER_HEARTBEAT_MS + 6000;
  const jobsReady = jobsUp && (activeJobInfo !== null || now - lastJobPollAt < env.WORKER_JOB_POLL_MS + 6000);
  const schedulerReady = !env.WORKER_SCHEDULER_ENABLED || (schedulerUp && now - lastSchedulerTickAt < env.WORKER_SCHEDULER_TICK_MS + 6000);
  return {
    ready: !stopping && databaseReady && jobsReady && schedulerReady,
    checks: { database: databaseReady ? "up" : "down", jobs: jobsReady ? "up" : "down", scheduler: !env.WORKER_SCHEDULER_ENABLED ? "disabled" : schedulerReady ? "up" : "down" },
    startedAt, activeJob: activeJobInfo,
    lastDatabaseCheckAt: lastCheckedAt ? new Date(lastCheckedAt).toISOString() : null,
    lastJobPollAt: lastJobPollAt ? new Date(lastJobPollAt).toISOString() : null,
    lastSchedulerTickAt: lastSchedulerTickAt ? new Date(lastSchedulerTickAt).toISOString() : null,
    schedulerErrorCode,
  };
}

function scheduleTick() {
  if (stopping || !env.WORKER_SCHEDULER_ENABLED) return;
  activeScheduler = loadMarketCalendar().then((calendar) => scheduleAnnouncementRun(getDatabase(), calendar, {
    analyze: env.WORKER_SCHEDULER_AI_ENABLED, analysisLimit: env.WORKER_SCHEDULER_AI_LIMIT,
  })).then((result) => {
    schedulerUp = true;
    lastSchedulerTickAt = Date.now(); schedulerErrorCode = null;
    if (result.status === "enqueued") log("pipeline_scheduled", result);
  }).catch((error) => {
    schedulerUp = false;
    lastSchedulerTickAt = Date.now();
    schedulerErrorCode = error instanceof CalendarError ? error.code : "SCHEDULER_UNAVAILABLE";
    log("scheduler_tick_failed", { code: schedulerErrorCode });
  }).finally(() => {
    if (!stopping) schedulerTimer = setTimeout(scheduleTick, env.WORKER_SCHEDULER_TICK_MS);
  });
}

function scheduleJob() {
  if (stopping) return;
  const db = getDatabase();
  activeJob = runJobOnce(db, workerId, createJobHandlers(db), stopJobs.signal, {
    onRecovery: (count) => log("jobs_recovered", { count }),
    onClaim: (job) => { activeJobInfo = { ...job, kind: publicJobKind(job.kind) }; jobsUp = true; lastJobPollAt = Date.now(); log("job_started", activeJobInfo); },
  }).then((result) => {
    jobsUp = true;
    lastJobPollAt = Date.now();
    if (result.jobId) log("job_finished", result);
  }).catch(() => {
    jobsUp = false;
    lastJobPollAt = Date.now();
    log("job_poll_failed");
  }).finally(() => {
    activeJobInfo = null;
    if (!stopping) jobTimer = setTimeout(scheduleJob, env.WORKER_JOB_POLL_MS);
  });
}

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ service: "swing-worker", event, at: new Date().toISOString(), ...details }));
}

async function heartbeat() {
  databaseUp = await checkDatabase();
  lastCheckedAt = Date.now();
  log("heartbeat", { database: databaseUp ? "up" : "down" });
}

function scheduleHeartbeat() {
  if (stopping) return;
  // Schedule after completion so slow checks cannot overlap.
  activeHeartbeat = heartbeat().finally(() => {
    if (!stopping) timer = setTimeout(scheduleHeartbeat, env.WORKER_HEARTBEAT_MS);
  });
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  if (request.url === "/health/live") {
    response.end(JSON.stringify({ service: "swing-worker", status: stopping ? "stopping" : "ok" }));
    return;
  }
  if (request.url === "/health/ready") {
    const { ready, checks } = runtimeStatus();
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({
      service: "swing-worker", status: ready ? "ok" : "degraded",
      checks,
    }));
    return;
  }
  if (request.url === "/health/status") {
    void getJobStatus(getDatabase()).then((queue) => {
      const runtime = runtimeStatus();
      response.writeHead(runtime.ready ? 200 : 503).end(JSON.stringify({ service: "swing-worker", status: runtime.ready ? "ok" : "degraded", runtime, queue }));
    }).catch(() => {
      response.writeHead(503).end(JSON.stringify({ service: "swing-worker", status: "degraded", code: "QUEUE_UNAVAILABLE" }));
    });
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
});

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  if (jobTimer) clearTimeout(jobTimer);
  if (schedulerTimer) clearTimeout(schedulerTimer);
  stopJobs.abort();
  log("stopping", { signal });
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await activeHeartbeat;
  await activeJob;
  await activeScheduler;
  await closeDatabase();
  clearTimeout(deadline);
  log("stopped");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
server.on("error", () => {
  log("health_server_failed");
  process.exitCode = 1;
  void shutdown("server-error");
});
server.listen(env.WORKER_PORT, env.WORKER_HOST, () => {
  log("started", { port: env.WORKER_PORT });
  scheduleHeartbeat();
  scheduleJob();
  scheduleTick();
});
