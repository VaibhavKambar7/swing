import type { PrismaClient } from "../../generated/prisma/client";
import { publicErrorCode } from "../jobs/retry";
export function quoteRecency(quote: { quoteTime: Date | null; retrievedAt: Date; quotePrice: { toString(): string } | null } | null, at = new Date()) {
  if (!quote?.quoteTime || !quote.quotePrice) return "missing" as const;
  if (quote.quoteTime > at || quote.retrievedAt > at || quote.retrievedAt < quote.quoteTime) return "invalid" as const;
  return at.getTime() - quote.quoteTime.getTime() <= 300000 && at.getTime() - quote.retrievedAt.getTime() <= 300000 ? "recent" as const : "stale" as const;
}
export async function getPriceCoverage(db: PrismaClient, selected: string[], at = new Date(), page = 1) {
  const [stocks, checkpoints, total] = await db.$transaction([
    db.instrument.findMany({ where: { exchange: "NSE", active: true, inUniverse: true }, orderBy: [{ symbol: "asc" }, { id: "asc" }], take: 100, skip: (page - 1) * 100,
      select: { id: true, symbol: true, name: true, marketSnapshots: { where: { provider: "yahoo-experimental" }, orderBy: [{ retrievedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }], take: 1,
        select: { quoteTime: true, quotePrice: true, retrievedAt: true, quoteDelayStatus: true, quoteFreshness: true, skippedBars: true },
      } },
    }),
    db.pollingCheckpoint.findMany({ where: { source: "market-import", scope: { startsWith: "yahoo-experimental:NSE:" } }, select: { scope: true, lastAttemptAt: true, lastSuccessAt: true, lastErrorCode: true } }),
    db.instrument.count({ where: { exchange: "NSE", active: true, inUniverse: true } }),
  ], { isolationLevel: "RepeatableRead" });
  const checkpointsBySymbol = new Map(checkpoints.map((entry) => [entry.scope.slice("yahoo-experimental:NSE:".length), entry]));
  const rows = stocks.map((stock) => {
    const checkpoint = checkpointsBySymbol.get(stock.symbol);
    const quote = stock.marketSnapshots[0] ?? null;
    return { id: stock.id, symbol: stock.symbol, name: stock.name, selected: !selected.length || selected.includes(stock.symbol), quote,
      recency: quoteRecency(quote, at), lastAttemptAt: checkpoint?.lastAttemptAt ?? null, lastSuccessAt: checkpoint?.lastSuccessAt ?? null,
      lastErrorCode: checkpoint?.lastErrorCode ? publicErrorCode(checkpoint.lastErrorCode) : null,
    };
  });
  // Resolve selections independently of the display limit; truncation must not
  // falsely label a configured stock as outside the active universe.
  const coveredSelections = await db.instrument.findMany({ where: { exchange: "NSE", active: true, inUniverse: true, symbol: { in: selected } }, select: { symbol: true } });
  return { rows, total, omitted: Math.max(0, total - (page - 1) * 100 - rows.length), selectedOutsideCoverage: selected.filter((symbol) => !coveredSelections.some((stock) => stock.symbol === symbol)), at };
}

// A slot-budget estimate, not an observed service-level guarantee. Latency,
// worker queueing and provider cooldowns can only make a sweep slower.
export function plannedSweepMinutes(instruments: number, batchSize: number, slotMs: number, intervalMs: number): number | null {
  if (![instruments, batchSize, slotMs, intervalMs].every((n) => Number.isFinite(n) && n > 0)) return null;
  const capacity = Math.min(Math.floor(batchSize), Math.floor(slotMs / intervalMs));
  return capacity > 0 ? Math.ceil(instruments / capacity) * slotMs / 60000 : null;
}
