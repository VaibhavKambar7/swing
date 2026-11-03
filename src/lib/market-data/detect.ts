import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type MarketSnapshotRecord } from "../../generated/prisma/client";
import { getMarketState, type MarketCalendar } from "../market/calendar";
import { MarketDataError, nseProviderSymbol, type MarketInstrument } from "./provider";

export const MOVEMENT_VERSION = "same-session-quotes-2pct-5min-v1";
const WINDOW_MS = 300000;
const TOLERANCE_MS = 60000;
const Calc = Prisma.Decimal.clone({ precision: 60 });
type Observation = Pick<MarketSnapshotRecord, "id" | "instrumentId" | "provider" | "providerSymbol" | "currency" | "retrievedAt" | "quoteTime" | "quotePrice" | "quoteFreshness" | "quoteDelayStatus">;
type Decision = { status: "skipped"; reason: string } | { status: "movement"; changePct: string; direction: "up" | "down" };
type StoredMovementResult = { status: "skipped"; reason: string } | { status: "inserted" | "duplicate"; signalId: string; changePct: string; direction: "up" | "down" };

export function evaluateMovement(current: Observation | null, reference: Observation | null, calendar: MarketCalendar, at: Date): Decision {
  const market = getMarketState(calendar, at);
  if (market.status === "unknown") return { status: "skipped", reason: "CALENDAR_COVERAGE_REQUIRED" };
  if (market.status !== "open" || !market.currentSession) return { status: "skipped", reason: "MARKET_CLOSED" };
  if (!current?.quoteTime || !current.quotePrice) return { status: "skipped", reason: "NO_CURRENT_QUOTE" };
  const now = at.getTime(), time = current.quoteTime.getTime();
  if (current.retrievedAt.getTime() > now || current.retrievedAt.getTime() < time || time > now || current.quoteFreshness === "clock_skew") return { status: "skipped", reason: "FUTURE_OBSERVATION" };
  if (now - time > WINDOW_MS) return { status: "skipped", reason: "STALE_CURRENT_QUOTE" };
  const sessionOpen = Date.parse(market.currentSession.opensAt), sessionClose = Date.parse(market.currentSession.closesAt);
  if (time < sessionOpen || time >= sessionClose) return { status: "skipped", reason: "QUOTE_OUTSIDE_SESSION" };
  if (!reference?.quoteTime || !reference.quotePrice) return { status: "skipped", reason: "NO_REFERENCE_QUOTE" };
  if (reference.instrumentId !== current.instrumentId || reference.provider !== current.provider || reference.providerSymbol !== current.providerSymbol || reference.currency !== current.currency || current.currency !== "INR") return { status: "skipped", reason: "INCOMPATIBLE_OBSERVATIONS" };
  const referenceTime = reference.quoteTime.getTime();
  if (referenceTime < sessionOpen || referenceTime >= sessionClose) return { status: "skipped", reason: "REFERENCE_OUTSIDE_SESSION" };
  if (reference.retrievedAt.getTime() > now || reference.retrievedAt.getTime() < referenceTime || reference.retrievedAt.getTime() - referenceTime > WINDOW_MS || reference.quoteFreshness !== "recent") return { status: "skipped", reason: "INVALID_REFERENCE_FRESHNESS" };
  if (time - referenceTime < WINDOW_MS || time - referenceTime > WINDOW_MS + TOLERANCE_MS) return { status: "skipped", reason: "REFERENCE_OUTSIDE_WINDOW" };
  const price = new Calc(current.quotePrice.toString()), base = new Calc(reference.quotePrice.toString());
  if (!price.isFinite() || !base.isFinite() || price.lte(0) || base.lte(0)) return { status: "skipped", reason: "INVALID_PRICES" };
  const change = price.minus(base).div(base).mul(100);
  if (change.abs().lt(2)) return { status: "skipped", reason: "BELOW_THRESHOLD" };
  const rounded = change.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  if (rounded.abs().gte("10000000000")) return { status: "skipped", reason: "CHANGE_OUT_OF_RANGE" };
  return { status: "movement", changePct: rounded.toFixed(8), direction: change.gt(0) ? "up" : "down" };
}

export async function detectStoredMovement(
  db: PrismaClient, calendar: MarketCalendar, instrument: MarketInstrument,
  provider = "yahoo-experimental", at = new Date(),
): Promise<StoredMovementResult> {
  const symbol = nseProviderSymbol(instrument).slice(0, -3);
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(provider)) throw new MarketDataError("INVALID_PROVIDER");
  const stock = await db.instrument.findFirst({ where: { exchange: "NSE", symbol, active: true, inUniverse: true, kind: "equity" }, select: { id: true } });
  if (!stock) throw new MarketDataError("INSTRUMENT_NOT_IN_UNIVERSE");
  const current = await db.marketSnapshotRecord.findFirst({
    where: { instrumentId: stock.id, provider },
    orderBy: [{ retrievedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
  });
  // Reject a bad latest retrieval; never silently fall back to an older one.
  const initial = evaluateMovement(current, null, calendar, at);
  if (initial.status === "skipped" && initial.reason !== "NO_REFERENCE_QUOTE") return initial;
  const reference = await db.marketSnapshotRecord.findFirst({ where: {
    instrumentId: stock.id, provider, providerSymbol: current!.providerSymbol, currency: current!.currency,
    quotePrice: { not: null }, quoteFreshness: "recent", retrievedAt: { lte: at },
    quoteTime: { lte: new Date(current!.quoteTime!.getTime() - WINDOW_MS), gte: new Date(current!.quoteTime!.getTime() - WINDOW_MS - TOLERANCE_MS) },
  }, orderBy: [{ quoteTime: "desc" }, { retrievedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }] });
  const decision = evaluateMovement(current, reference, calendar, at);
  if (decision.status === "skipped") return decision;
  const key = createHash("sha256").update(JSON.stringify([MOVEMENT_VERSION, stock.id, provider, current!.providerSymbol, current!.quoteTime!.toISOString()])).digest("hex");
  const dedupeKey = `movement:${key}`;
  return db.$transaction(async (tx) => {
    const created = await tx.signal.createMany({ data: [{
      instrumentId: stock.id, origin: "movement", dedupeKey, detectorVersion: MOVEMENT_VERSION,
      observedAt: current!.quoteTime!, windowStart: reference!.quoteTime!,
      price: current!.quotePrice, referencePrice: reference!.quotePrice, priceChangePct: decision.changePct,
      context: {
        provider, providerSymbol: current!.providerSymbol, currentSnapshotId: current!.id, referenceSnapshotId: reference!.id,
        detectedAt: at.toISOString(), currentRetrievedAt: current!.retrievedAt.toISOString(), referenceRetrievedAt: reference!.retrievedAt.toISOString(),
        direction: decision.direction, thresholdPct: "2", windowSeconds: 300, referenceToleranceSeconds: 60,
        methodology: "same-provider same-session quote change; no candle baseline",
        delayStatus: current!.quoteDelayStatus ?? "unknown", sourceQuality: "provider data and delay not independently verified",
      },
    }], skipDuplicates: true });
    const signal = await tx.signal.findUniqueOrThrow({ where: { dedupeKey }, select: { id: true, priceChangePct: true } });
    if (!signal.priceChangePct) throw new MarketDataError("INVALID_STORED_MOVEMENT");
    // Persist the signal and its evidence-linking work together; no AI is implicit.
    await tx.job.createMany({ data: [{ kind: "movements.research", dedupeKey: `movement-evidence:${signal.id}`, signalId: signal.id,
      payload: { signalId: signal.id, analyze: false } }], skipDuplicates: true });
    const status: "inserted" | "duplicate" = created.count ? "inserted" : "duplicate";
    const direction: "up" | "down" = signal.priceChangePct.gt(0) ? "up" : "down";
    return { status, signalId: signal.id, changePct: signal.priceChangePct.toFixed(8), direction };
  });
}
