import "../src/lib/config/load-env";
import { z } from "zod";
const base = z.string().url().refine((value) => { const url = URL.parse(value); return url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; });
async function check(service: "swing-web" | "swing-worker", value: string, path: string) {
  const parsed = base.safeParse(value);
  if (!parsed.success) return { service, ready: false, code: "INVALID_HEALTH_URL" };
  try {
    const response = await fetch(new URL(path, parsed.data), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
    const checks = service === "swing-web"
      ? z.object({ database: z.literal("up"), worker: z.literal("up") })
      : z.object({ database: z.literal("up"), jobs: z.literal("up"), scheduler: z.enum(["up", "disabled"]) });
    const body = z.object({ service: z.literal(service), status: z.literal("ok"), checks }).safeParse(await response.json());
    return { service, ready: response.status === 200 && body.success, code: response.status === 200 && body.success ? "READY" : "NOT_READY" };
  } catch { return { service, ready: false, code: "HEALTH_UNAVAILABLE" }; }
}
async function main() {
  const results = await Promise.all([
    check("swing-web", process.env.SWING_WEB_URL ?? "http://127.0.0.1:3000", "/api/health/ready"),
    check("swing-worker", process.env.WORKER_HEALTH_URL ?? "http://127.0.0.1:3001", "/health/ready"),
  ]);
  const ready = results.every((result) => result.ready);
  console.log(JSON.stringify({ event: "combined_readiness", ready, checks: results }));
  if (!ready) process.exitCode = 1;
}
void main();
