import { createHash, timingSafeEqual } from "node:crypto";
function equal(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
export function accessConfigured(env = process.env) {
  return Boolean(env.SWING_AUTH_USER && env.SWING_AUTH_PASSWORD && env.SWING_AUTH_PASSWORD.length >= 24);
}
export function authorize(header: string | null, env = process.env) {
  if (!accessConfigured(env) || !header?.startsWith("Basic ") || header.length > 4096) return false;
  const supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
  return equal(supplied, `${env.SWING_AUTH_USER}:${env.SWING_AUTH_PASSWORD}`);
}
export function workerAuthorized(header: string | undefined, env = process.env) {
  return Boolean(env.WORKER_ACCESS_TOKEN && env.WORKER_ACCESS_TOKEN.length >= 32 && equal(header ?? "", `Bearer ${env.WORKER_ACCESS_TOKEN}`));
}
export function workerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.WORKER_ACCESS_TOKEN ?? ""}` };
}
