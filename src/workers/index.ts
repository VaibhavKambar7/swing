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

const env = getEnv();
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

function scheduleTick() {
  if (stopping || !env.WORKER_SCHEDULER_ENABLED) return;
  activeScheduler = loadMarketCalendar().then((calendar) => scheduleAnnouncementRun(getDatabase(), calendar, {
    analyze: env.WORKER_SCHEDULER_AI_ENABLED, analysisLimit: env.WORKER_SCHEDULER_AI_LIMIT,
  })).then((result) => {
    schedulerUp = true;
    if (result.status === "enqueued") log("pipeline_scheduled", result);
  }).catch((error) => {
    schedulerUp = false;
    log("scheduler_tick_failed", { code: error instanceof CalendarError ? error.code : "SCHEDULER_UNAVAILABLE" });
  }).finally(() => {
    if (!stopping) schedulerTimer = setTimeout(scheduleTick, env.WORKER_SCHEDULER_TICK_MS);
  });
}

function scheduleJob() {
  if (stopping) return;
  const db = getDatabase();
  activeJob = runJobOnce(db, workerId, createJobHandlers(db), stopJobs.signal).then((result) => {
    jobsUp = true;
    if (result.jobId) log("job_finished", result);
  }).catch(() => {
    jobsUp = false;
    log("job_poll_failed");
  }).finally(() => {
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
    const fresh = Date.now() - lastCheckedAt < env.WORKER_HEARTBEAT_MS + 6000;
    const ready = !stopping && databaseUp && fresh && jobsUp && schedulerUp;
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({
      service: "swing-worker", status: ready ? "ok" : "degraded",
      checks: { database: databaseUp && fresh ? "up" : "down", jobs: jobsUp ? "up" : "down", scheduler: !env.WORKER_SCHEDULER_ENABLED ? "disabled" : schedulerUp ? "up" : "down" },
    }));
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
