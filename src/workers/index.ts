import "../lib/config/load-env";
import { createServer } from "node:http";
import { getEnv } from "../lib/config/env";
import { closeDatabase } from "../lib/db";
import { checkDatabase } from "../lib/health";

const env = getEnv();
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let activeHeartbeat: Promise<void> | undefined;
let databaseUp = false;
let lastCheckedAt = 0;

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
    const ready = !stopping && databaseUp && fresh;
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({
      service: "swing-worker", status: ready ? "ok" : "degraded",
      checks: { database: databaseUp && fresh ? "up" : "down" },
    }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
});

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  log("stopping", { signal });
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await activeHeartbeat;
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
});
