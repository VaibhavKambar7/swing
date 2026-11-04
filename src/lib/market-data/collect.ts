import type { PrismaClient } from "../../generated/prisma/client";
import type { MarketCalendar } from "../market/calendar";
import { detectStoredMovement } from "./detect";
import { importMarketSnapshot } from "./persist";
import { MarketDataError, type MarketDataProvider } from "./provider";
import { priceJobSchema } from "./scheduler";

export async function collectPrice(db: PrismaClient, provider: MarketDataProvider, calendar: MarketCalendar, input: unknown, signal: AbortSignal, clock: () => Date = () => new Date()) {
  const { symbol, days, validUntil } = priceJobSchema.parse(input);
  signal.throwIfAborted();
  // Expired jobs do not replay stale polling slots as new market observations.
  if (validUntil && clock().getTime() >= Date.parse(validUntil)) return { status: "skipped" as const, reason: "PRICE_SLOT_EXPIRED" };
  const identity = { source: "market-import", scope: `${provider.name}:NSE:${symbol}` };
  await db.pollingCheckpoint.upsert({ where: { source_scope: identity }, create: { ...identity, lastAttemptAt: clock() }, update: { lastAttemptAt: clock(), updatedAt: clock() } });
  try {
    const imported = await importMarketSnapshot(db, provider, { exchange: "NSE", symbol }, days, signal);
    signal.throwIfAborted();
    const movement = await detectStoredMovement(db, calendar, { exchange: "NSE", symbol }, provider.name, clock());
    signal.throwIfAborted();
    const now = clock();
    await db.pollingCheckpoint.update({ where: { source_scope: identity }, data: {
      lastSuccessAt: now, lastErrorCode: null, updatedAt: now,
      cursor: { snapshotId: imported.snapshotId, quoteStored: imported.quoteStored, movementStatus: movement.status, movementReason: movement.status === "skipped" ? movement.reason : null },
    } });
    return { status: "collected" as const, ...imported, movement };
  } catch (error) {
    const code = signal.aborted ? "PRICE_COLLECTION_INTERRUPTED" : error instanceof MarketDataError ? error.code : "PRICE_COLLECTION_FAILED";
    await db.pollingCheckpoint.update({ where: { source_scope: identity }, data: { lastErrorCode: code, updatedAt: clock() } });
    throw error;
  }
}
