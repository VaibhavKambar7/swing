import type { PrismaClient } from "../../generated/prisma/client";
import { setTimeout } from "node:timers/promises";
export function retryAfterMs(value: string | null, at = Date.now()) {
  if (!value) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - at;
  return Number.isFinite(delay) ? Math.min(3600000, Math.max(0, delay)) : 0;
}
// Database-reserved host slots serialize manual/worker calls across processes.
// Sleeping happens outside the transaction and is abortable.
export function rateLimitedFetch(db: PrismaClient, fetcher: typeof fetch = fetch, intervalMs = 1000): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = { source: "provider-rate-limit", scope: url.hostname };
    const wait = await db.$transaction(async (tx) => {
      const row = await tx.pollingCheckpoint.upsert({ where: { source_scope: key }, create: key, update: { updatedAt: new Date() } });
      await tx.$queryRaw`SELECT id FROM polling_checkpoints WHERE id = ${row.id}::uuid FOR UPDATE`;
      const current = await tx.pollingCheckpoint.findUniqueOrThrow({ where: { id: row.id } });
      const now = Date.now(), slot = Math.max(now, current.lastPublishedAt?.getTime() ?? 0);
      // Long cooldowns are safe retryable failures rather than long occupied leases.
      if (slot - now > 60000) throw new Error("PROVIDER_COOLDOWN");
      await tx.pollingCheckpoint.update({ where: { id: row.id }, data: { lastPublishedAt: new Date(slot + intervalMs), updatedAt: new Date() } });
      return slot - now;
    });
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (wait > 0) await setTimeout(wait, undefined, { signal: signal ?? undefined });
    signal?.throwIfAborted();
    const response = await fetcher(input, init);
    if (response.status === 429 || response.status === 503) {
      const delay = retryAfterMs(response.headers.get("retry-after"));
      if (delay > 0) {
        const until = new Date(Date.now() + delay);
        await db.pollingCheckpoint.updateMany({ where: { ...key, OR: [{ lastPublishedAt: null }, { lastPublishedAt: { lt: until } }] }, data: { lastPublishedAt: until, lastErrorCode: "PROVIDER_COOLDOWN", updatedAt: new Date() } });
      }
    }
    return response;
  };
}
