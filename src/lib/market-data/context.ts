import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { getMarketState, marketDate, type MarketCalendar } from "../market/calendar";
const Calc = Prisma.Decimal.clone({ precision: 60 });
export function percentageChange(base: string, value: string): string | null {
  const b = new Calc(base), v = new Calc(value);
  if (!b.isFinite() || !v.isFinite() || b.lte(0) || v.lte(0)) return null;
  const pct = v.minus(b).div(b).mul(100);
  return pct.abs().gte("10000000000") ? null : pct.toFixed(8);
}
export async function comparisonChange(db: PrismaClient, calendar: MarketCalendar, instrumentId: string | null, start: Date, end: Date, knownAt: Date, provider: string) {
  if (!instrumentId) return { status: "unavailable" as const, reason: "INDEX_NOT_MAPPED" };
  const instrument = await db.instrument.findUnique({ where: { id: instrumentId }, select: { kind: true, symbol: true } });
  if (instrument?.kind !== "index") return { status: "unavailable" as const, reason: "INVALID_INDEX_MAPPING" };
  const get = (target: Date) => db.marketSnapshotRecord.findFirst({ where: { instrumentId, provider, currency: "INR", quoteFreshness: "recent", quotePrice: { not: null }, quoteAgeSeconds: { gte: 0, lte: 300 }, quoteTime: { lte: target, gte: new Date(target.getTime() - 60000) }, retrievedAt: { lte: knownAt }, recordedAt: { lte: knownAt } }, orderBy: [{ quoteTime: "desc" }, { retrievedAt: "asc" }, { id: "asc" }] });
  const [reference, observed] = await Promise.all([get(start), get(end)]);
  if (!reference?.quoteTime || !reference.quotePrice || !observed?.quoteTime || !observed.quotePrice) return { status: "unavailable" as const, reason: "ALIGNED_INDEX_QUOTES_MISSING", symbol: instrument.symbol };
  if (reference.providerSymbol !== observed.providerSymbol || reference.quoteTime >= observed.quoteTime || reference.retrievedAt < reference.quoteTime || observed.retrievedAt < observed.quoteTime) return { status: "unavailable" as const, reason: "INCOMPATIBLE_INDEX_QUOTES" };
  for (const [target, quote] of [[start, reference], [end, observed]] as const) {
    const state = getMarketState(calendar, target);
    if (state.status !== "open" || !state.currentSession || quote.quoteTime! < new Date(state.currentSession.opensAt)) return { status: "unavailable" as const, reason: "INDEX_QUOTES_OUTSIDE_SESSION" };
  }
  const changePct = percentageChange(reference.quotePrice.toString(), observed.quotePrice.toString());
  if (changePct === null) return { status: "unavailable" as const, reason: "INVALID_INDEX_PRICES" };
  return { status: "observed" as const, symbol: instrument.symbol, changePct, snapshotIds: [reference.id, observed.id], referenceAt: reference.quoteTime.toISOString(), observedAt: observed.quoteTime.toISOString(), priceBasis: "provider_native_unverified" };
}
export function volatilityComparison(changes: number[], current: number, sessions: number) {
  if (changes.length < 20 || sessions < 5) return { status: "unavailable" as const, reason: "INSUFFICIENT_PRIOR_INTRADAY_HISTORY", sampleCount: changes.length, sessions };
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const deviation = Math.sqrt(changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (changes.length - 1));
  if (!Number.isFinite(deviation) || deviation <= 0) return { status: "unavailable" as const, reason: "ZERO_OR_INVALID_VARIANCE", sampleCount: changes.length, sessions };
  return { status: "observed" as const, sampleCount: changes.length, sessions, meanChangePct: mean.toFixed(8), standardDeviationPct: deviation.toFixed(8), standardDeviationsFromMean: ((current - mean) / deviation).toFixed(4) };
}
export async function buildMarketContext(db: PrismaClient, calendar: MarketCalendar, stock: { id: string; benchmarkId: string | null; sectorIndexId: string | null }, provider: string, start: Date, end: Date, changePct: string, at: Date) {
  const [benchmark, sector, history] = await Promise.all([
    comparisonChange(db, calendar, stock.benchmarkId, start, end, at, provider), comparisonChange(db, calendar, stock.sectorIndexId, start, end, at, provider),
    db.marketSnapshotRecord.findMany({ where: { instrumentId: stock.id, provider, currency: "INR", quoteFreshness: "recent", quotePrice: { not: null }, quoteAgeSeconds: { gte: 0, lte: 300 }, quoteTime: { gte: new Date(end.getTime() - 30 * 86400000), lt: new Date(`${marketDate(end)}T00:00:00+05:30`) }, recordedAt: { lte: at }, retrievedAt: { lte: at } }, orderBy: [{ quoteTime: "asc" }, { retrievedAt: "asc" }], take: 5000 }),
  ]);
  const relative = (comparison: typeof benchmark) => comparison.status === "observed" ? { ...comparison, excessChangePercentagePoints: new Calc(changePct).minus(comparison.changePct!).toFixed(8) } : comparison;
  const unique = history.filter((q, i, all) => q.quoteTime && q.quotePrice && q.retrievedAt >= q.quoteTime && (i === 0 || q.quoteTime.getTime() !== all[i - 1].quoteTime?.getTime()));
  const changes: number[] = [], ids: string[][] = []; const sessions = new Set<string>();
  // Non-overlapping same-session 5–6 minute quote pairs, never daily volatility.
  let previousUsed = -Infinity;
  for (let i = 1; i < unique.length; i++) {
    const current = unique[i], time = current.quoteTime!.getTime();
    if (time - previousUsed < 300000) continue;
    const reference = unique.slice(0, i).reverse().find((q) => time - q.quoteTime!.getTime() >= 300000 && time - q.quoteTime!.getTime() <= 360000);
    if (!reference || reference.providerSymbol !== current.providerSymbol) continue;
    const state = getMarketState(calendar, current.quoteTime!);
    if (state.status !== "open" || !state.currentSession || reference.quoteTime! < new Date(state.currentSession.opensAt)) continue;
    const change = percentageChange(reference.quotePrice!.toString(), current.quotePrice!.toString());
    if (change === null) continue;
    changes.push(Number(change)); ids.push([reference.id, current.id]); sessions.add(marketDate(current.quoteTime!)); previousUsed = time;
  }
  return { benchmark: relative(benchmark), sector: relative(sector), usualVolatility: { ...volatilityComparison(changes, Number(changePct), sessions.size), methodology: "non-overlapping prior 5–6 minute pairs over at most 30 calendar days; 5000 observations maximum", snapshotPairs: ids }, relativeVolume: { status: "unavailable", reason: "COMPARABLE_INTRADAY_VOLUME_NOT_PROVIDED" }, limitations: "Provider-native, unadjusted context; distributions and corporate actions unverified. Comparison does not establish a cause or recommendation." };
}
