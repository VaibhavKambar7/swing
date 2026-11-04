import type { PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { CalendarError, getMarketDay, getMarketState, type MarketCalendar } from "../market/calendar";

export const priceSymbolsSchema = z.array(z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,29}$/)).max(2000).transform((symbols) => [...new Set(symbols)].sort());
export const priceJobSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,29}$/),
  days: z.number().int().min(1).max(365).default(7),
  validUntil: z.string().datetime().optional(),
}).strict();
const CADENCE_MS = 300000;
export function planPriceCollection(calendar: MarketCalendar, at = new Date()) {
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
  const slot = anchor + Math.floor((at.getTime() - anchor) / CADENCE_MS) * CADENCE_MS;
  return { status: "due" as const, mode, slotStart: new Date(slot).toISOString(), validUntil: new Date(slot + CADENCE_MS).toISOString() };
}
export async function schedulePriceCollection(db: PrismaClient, calendar: MarketCalendar, symbols: string[], days = 7, at = new Date(), batchSize = 20, intervalMs = 1000) {
  z.number().int().min(1).max(100).parse(batchSize);
  z.number().int().min(250).max(60000).parse(intervalMs);
  const selected = priceSymbolsSchema.parse(symbols);
  z.number().int().min(1).max(365).parse(days);
  const plan = planPriceCollection(calendar, at);
  if (plan.status !== "due") return { ...plan, enqueued: 0, busy: 0, alreadyScheduled: 0, outsideUniverse: [] as string[] };
  return db.$transaction(async (tx) => {
    const checkpoint = await tx.pollingCheckpoint.upsert({ where: { source_scope: { source: "swing-scheduler", scope: "prices-v1" } },
      create: { source: "swing-scheduler", scope: "prices-v1" }, update: { lastAttemptAt: at },
    });
    await tx.$queryRaw`SELECT id FROM polling_checkpoints WHERE id = ${checkpoint.id}::uuid FOR UPDATE`;
    const stocks = await tx.instrument.findMany({ where: { ...(selected.length ? { symbol: { in: selected } } : {}), exchange: "NSE", active: true, inUniverse: true }, orderBy: { symbol: "asc" }, select: { symbol: true } });
    const outsideUniverse = selected.filter((symbol) => !stocks.some((stock) => stock.symbol === symbol));
    let enqueued = 0, busy = 0, alreadyScheduled = 0;
    const previous = checkpoint.cursor && typeof checkpoint.cursor === "object" && !Array.isArray(checkpoint.cursor) && typeof checkpoint.cursor.after === "string" ? checkpoint.cursor.after : "";
    const ordered = [...stocks.filter((s) => s.symbol > previous), ...stocks.filter((s) => s.symbol <= previous)];
    let after = previous;
    // Persisted round-robin rotation bounds each slot without starving later symbols.
    const capacity = Math.min(batchSize, Math.max(1, Math.floor((Date.parse(plan.validUntil) - at.getTime()) / intervalMs)));
    for (const { symbol } of ordered) {
      if (enqueued >= capacity) break;
      after = symbol;
      const dedupeKey = `scheduled:prices:v1:${symbol}:${plan.slotStart}`;
      if (await tx.job.findUnique({ where: { dedupeKey }, select: { id: true } })) { alreadyScheduled++; continue; }
      if (await tx.job.findFirst({ where: { kind: "prices.collect", status: { in: ["pending", "retry", "running"] }, payload: { path: ["symbol"], equals: symbol } }, select: { id: true } })) { busy++; continue; }
      await tx.job.create({ data: { kind: "prices.collect", dedupeKey, payload: { symbol, days, validUntil: plan.validUntil }, runAfter: new Date(at.getTime() + enqueued * intervalMs), maxAttempts: 3 } });
      enqueued++;
    }
    await tx.pollingCheckpoint.update({ where: { id: checkpoint.id }, data: {
      lastAttemptAt: at, lastSuccessAt: at, lastErrorCode: null, updatedAt: at,
      cursor: { slotStart: plan.slotStart, mode: plan.mode, enqueued, busy, outsideUniverse, after, totalEligible: stocks.length, batchSize, intervalMs },
    } });
    return { ...plan, enqueued, busy, alreadyScheduled, outsideUniverse };
  }, { timeout: 15000 });
}
