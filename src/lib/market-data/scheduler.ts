import type { PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { CalendarError, getMarketDay, getMarketState, type MarketCalendar } from "../market/calendar";
import { WORKSPACE_OWNER } from "../dashboard/read-state";

export const priceSymbolsSchema = z.array(z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,29}$/)).max(2000).transform((symbols) => [...new Set(symbols)].sort());
export const priceJobSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,29}$/),
  days: z.number().int().min(1).max(365).default(7),
  validUntil: z.string().datetime().optional(),
}).strict();
const CADENCE_MS = 300000;
export function planPriceCollection(calendar: MarketCalendar, at = new Date(), cadenceMs = CADENCE_MS) {
  z.number().int().min(30000).max(300000).multipleOf(30000).parse(cadenceMs);
  const state = getMarketState(calendar, at);
  if (state.status === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  let anchor: number;
  let mode: "session" | "post_close";
  if (state.currentSession) {
    anchor = Date.parse(state.currentSession.opensAt);
    mode = "session";
  } else {
    const day = getMarketDay(calendar, state.localDate);
    const last = day.sessions.at(-1);
    if (!last) return { status: "skipped" as const, reason: "NO_TRADING_SESSION" };
    anchor = Date.parse(`${state.localDate}T${last.close}:00+05:30`);
    // Two final collection slots, ahead of the preliminary closing report.
    if (at.getTime() < anchor || at.getTime() >= anchor + 2 * CADENCE_MS) return { status: "skipped" as const, reason: "OUTSIDE_COLLECTION_WINDOW" };
    mode = "post_close";
  }
  const slot = anchor + Math.floor((at.getTime() - anchor) / cadenceMs) * cadenceMs;
  return { status: "due" as const, mode, slotStart: new Date(slot).toISOString(), validUntil: new Date(slot + cadenceMs).toISOString() };
}
export async function schedulePriceCollection(db: PrismaClient, calendar: MarketCalendar, symbols: string[], days = 7, at = new Date(), batchSize = 20, intervalMs = 1000, cadenceMs = CADENCE_MS) {
  z.number().int().min(1).max(100).parse(batchSize);
  z.number().int().min(250).max(60000).parse(intervalMs);
  const selected = priceSymbolsSchema.parse(symbols);
  z.number().int().min(1).max(365).parse(days);
  const plan = planPriceCollection(calendar, at, cadenceMs);
  if (plan.status !== "due") return { ...plan, enqueued: 0, busy: 0, alreadyScheduled: 0, outsideUniverse: [] as string[] };
  return db.$transaction(async (tx) => {
    const checkpoint = await tx.pollingCheckpoint.upsert({ where: { source_scope: { source: "swing-scheduler", scope: "prices-v1" } },
      create: { source: "swing-scheduler", scope: "prices-v1" }, update: { lastAttemptAt: at },
    });
    await tx.$queryRaw`SELECT id FROM polling_checkpoints WHERE id = ${checkpoint.id}::uuid FOR UPDATE`;
    const cursor = checkpoint.cursor && typeof checkpoint.cursor === "object" && !Array.isArray(checkpoint.cursor) ? checkpoint.cursor : {};
    if (cursor.slotStart === plan.slotStart) return { ...plan, enqueued: 0, busy: 0, alreadyScheduled: 1, outsideUniverse: [] as string[] };
    const stocks = await tx.instrument.findMany({ where: { ...(selected.length ? { symbol: { in: selected } } : {}), exchange: "NSE", active: true, inUniverse: true }, orderBy: { symbol: "asc" }, select: { symbol: true } });
    const watchlist = selected.length ? [] : await tx.watchlistEntry.findMany({
      where: { ownerKey: WORKSPACE_OWNER, instrument: { exchange: "NSE", active: true, inUniverse: true } },
      select: { instrument: { select: { symbol: true } } },
    });
    const priority = new Set(watchlist.map((entry) => entry.instrument.symbol));
    const outsideUniverse = selected.filter((symbol) => !stocks.some((stock) => stock.symbol === symbol));
    const queued = await tx.job.findMany({ where: { kind: "prices.collect", status: { in: ["pending", "retry", "running"] } }, select: { payload: true } });
    const busySymbols = new Set(queued.map((j) => j.payload && typeof j.payload === "object" && !Array.isArray(j.payload) ? j.payload.symbol : null));
    const existing = await tx.job.findMany({ where: { kind: "prices.collect", dedupeKey: { startsWith: "scheduled:prices:v1:", endsWith: plan.slotStart } }, select: { dedupeKey: true } });
    const existingKeys = new Set(existing.map((j) => j.dedupeKey));
    const pending: { kind: string; dedupeKey: string; payload: { symbol: string; days: number; validUntil: string }; runAfter: Date; maxAttempts: number }[] = [];
    let enqueued = 0, busy = 0, alreadyScheduled = 0;
    const previous = checkpoint.cursor && typeof checkpoint.cursor === "object" && !Array.isArray(checkpoint.cursor) && typeof checkpoint.cursor.after === "string" ? checkpoint.cursor.after : "";
    const previousPriority = checkpoint.cursor && typeof checkpoint.cursor === "object" && !Array.isArray(checkpoint.cursor) && typeof checkpoint.cursor.priorityAfter === "string" ? checkpoint.cursor.priorityAfter : "";
    const rotate = (rows: typeof stocks, after: string) => [...rows.filter((s) => s.symbol > after), ...rows.filter((s) => s.symbol <= after)];
    const ordered = [...rotate(stocks.filter((s) => priority.has(s.symbol)), previousPriority), ...rotate(stocks.filter((s) => !priority.has(s.symbol)), previous)];
    let after = previous;
    let priorityAfter = previousPriority;
    // Persisted round-robin rotation bounds each slot without starving later symbols.
    const capacity = Math.min(batchSize, Math.max(1, Math.floor((Date.parse(plan.validUntil) - at.getTime()) / intervalMs)));
    for (const { symbol } of ordered) {
      if (enqueued >= capacity) break;
      if (priority.has(symbol)) priorityAfter = symbol; else after = symbol;
      const dedupeKey = `scheduled:prices:v1:${symbol}:${plan.slotStart}`;
      if (existingKeys.has(dedupeKey)) { alreadyScheduled++; continue; }
      if (busySymbols.has(symbol)) { busy++; continue; }
      pending.push({ kind: "prices.collect", dedupeKey, payload: { symbol, days, validUntil: plan.validUntil }, runAfter: new Date(at.getTime() + enqueued * intervalMs), maxAttempts: 3 });
      enqueued++;
    }
    if (pending.length) await tx.job.createMany({ data: pending, skipDuplicates: true });
    await tx.pollingCheckpoint.update({ where: { id: checkpoint.id }, data: {
      lastAttemptAt: at, lastSuccessAt: at, lastErrorCode: null, updatedAt: at,
      cursor: { slotStart: plan.slotStart, mode: plan.mode, enqueued, busy, alreadyScheduled, outsideUniverse, after, priorityAfter, watchlistCount: priority.size, totalEligible: stocks.length, batchSize, intervalMs, cadenceMs },
    } });
    return { ...plan, enqueued, busy, alreadyScheduled, outsideUniverse };
  }, { timeout: 15000 });
}
