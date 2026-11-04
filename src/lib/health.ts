import { workerHeaders } from "@/lib/auth/access";
import { getDatabase } from "./db";
import { getEnv } from "./config/env";

export async function checkDatabase(): Promise<boolean> {
  try {
    await getDatabase().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function checkWorker(): Promise<boolean> {
  try {
    const url = new URL("/health/ready", getEnv().WORKER_HEALTH_URL);
    const response = await fetch(url, { headers: workerHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.service === "swing-worker" && body.status === "ok";
  } catch {
    return false;
  }
}
