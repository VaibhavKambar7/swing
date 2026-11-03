import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { marketDate } from "../market/calendar";
import { MarketDataError, nseProviderSymbol, validateHistoryDays, type MarketDataProvider, type MarketInstrument } from "./provider";

const timestamp = z.string().datetime({ offset: true });
const price = z.string().min(1).max(80);
const schema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  providerSymbol: z.string().regex(/^[A-Za-z0-9^&._-]{1,100}$/),
  instrument: z.object({ exchange: z.literal("NSE"), symbol: z.string() }).strict(),
  retrievedAt: timestamp, requestedCalendarDays: z.number().int().min(1).max(365), skippedBars: z.number().int().min(0).max(2000),
  quote: z.object({ price, currency: z.literal("INR"), marketTime: timestamp, retrievedAt: timestamp,
    ageSeconds: z.number(), freshness: z.enum(["recent", "stale", "clock_skew"]), delayStatus: z.literal("unknown") }).strict().nullable(),
  candles: z.array(z.object({ sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timestamp,
    open: price, high: price, low: price, close: price, adjustedClose: price.nullable(),
    volume: z.string().regex(/^\d{1,19}$/).nullable(), priceBasis: z.literal("provider_native_unverified"), completion: z.literal("unknown"),
  }).strict()).max(2000),
}).strict();

function decimal(value: string) {
  if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new MarketDataError("INVALID_PRICE_DECIMAL");
  const parsed = new Prisma.Decimal(value);
  // Reject values PostgreSQL would round or overflow rather than losing source precision.
  if (!parsed.isFinite() || parsed.isZero() || parsed.e > 19 || parsed.decimalPlaces() > 18) throw new MarketDataError("PRICE_PRECISION_UNSUPPORTED");
  return parsed.toString();
}

export function normalizeMarketSnapshot(value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MarketDataError("INVALID_MARKET_SNAPSHOT");
  const data = parsed.data;
  const mappedSymbol = nseProviderSymbol(data.instrument);
  data.instrument.symbol = mappedSymbol.slice(0, -3);
  if (data.provider === "yahoo-experimental" && data.providerSymbol !== mappedSymbol) throw new MarketDataError("INSTRUMENT_METADATA_MISMATCH");
  data.retrievedAt = new Date(data.retrievedAt).toISOString();
  const retrieved = Date.parse(data.retrievedAt);
  if (data.quote) {
    const quote = data.quote;
    const age = (retrieved - Date.parse(quote.marketTime)) / 1000;
    const freshness = age < 0 ? "clock_skew" : age > 300 ? "stale" : "recent";
    if (Date.parse(quote.retrievedAt) !== retrieved || age < -60 || Math.abs(quote.ageSeconds - age) > 0.001 || quote.freshness !== freshness) throw new MarketDataError("INCONSISTENT_QUOTE_FRESHNESS");
    quote.price = decimal(quote.price);
    quote.marketTime = new Date(quote.marketTime).toISOString();
    quote.retrievedAt = data.retrievedAt;
    quote.ageSeconds = age;
  }
  const seen = new Set<string>();
  for (const candle of data.candles) {
    const time = new Date(candle.timestamp);
    if (marketDate(time) !== candle.sessionDate || time.getTime() > retrieved + 60000 || seen.has(candle.sessionDate)) throw new MarketDataError("INVALID_CANDLE_SESSION");
    seen.add(candle.sessionDate);
    candle.timestamp = time.toISOString();
    for (const key of ["open", "high", "low", "close"] as const) candle[key] = decimal(candle[key]);
    if (candle.adjustedClose !== null) candle.adjustedClose = decimal(candle.adjustedClose);
    const low = new Prisma.Decimal(candle.low), high = new Prisma.Decimal(candle.high);
    if (low.gt(candle.open) || low.gt(candle.close) || high.lt(candle.open) || high.lt(candle.close) || low.gt(high)) throw new MarketDataError("INVALID_CANDLE_OHLC");
    if (candle.volume !== null) {
      const volume = BigInt(candle.volume);
      if (volume > BigInt("9223372036854775807")) throw new MarketDataError("VOLUME_OVERFLOW");
      candle.volume = volume.toString();
    }
  }
  data.candles.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return data;
}

export async function storeMarketSnapshot(db: PrismaClient, value: unknown) {
  const snapshot = normalizeMarketSnapshot(value);
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return db.$transaction(async (tx) => {
    const instrument = await tx.instrument.findFirst({ where: { exchange: snapshot.instrument.exchange, symbol: snapshot.instrument.symbol, kind: "equity", active: true, inUniverse: true }, select: { id: true } });
    if (!instrument) throw new MarketDataError("INSTRUMENT_NOT_IN_UNIVERSE");
    const identity = { instrumentId: instrument.id, provider: snapshot.provider, contentHash: hash };
    const quote = snapshot.quote;
    const created = await tx.marketSnapshotRecord.createMany({ data: [{ ...identity,
      providerSymbol: snapshot.providerSymbol, retrievedAt: new Date(snapshot.retrievedAt), requestedDays: snapshot.requestedCalendarDays, skippedBars: snapshot.skippedBars,
      quotePrice: quote?.price ?? null, quoteTime: quote ? new Date(quote.marketTime) : null, quoteAgeSeconds: quote?.ageSeconds ?? null,
      quoteFreshness: quote?.freshness ?? null, quoteDelayStatus: quote?.delayStatus ?? null,
    }], skipDuplicates: true });
    const record = await tx.marketSnapshotRecord.findUniqueOrThrow({ where: { instrumentId_provider_contentHash: identity }, select: { id: true } });
    if (created.count === 0) return { snapshotId: record.id, inserted: false, candlesInserted: 0, quoteStored: quote !== null };
    if (snapshot.candles.length) await tx.marketCandleRecord.createMany({ data: snapshot.candles.map((candle) => ({
      snapshotId: record.id, sessionDate: new Date(`${candle.sessionDate}T00:00:00Z`), sourceTime: new Date(candle.timestamp),
      open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume === null ? null : BigInt(candle.volume),
      adjustedClose: candle.adjustedClose, priceBasis: candle.priceBasis, completion: candle.completion,
    })) });
    return { snapshotId: record.id, inserted: true, candlesInserted: snapshot.candles.length, quoteStored: quote !== null };
  });
}

export async function importMarketSnapshot(db: PrismaClient, provider: MarketDataProvider, instrument: MarketInstrument, days = 30) {
  validateHistoryDays(days);
  const symbol = nseProviderSymbol(instrument).slice(0, -3);
  if (!await db.instrument.findFirst({ where: { exchange: instrument.exchange, symbol, active: true, inUniverse: true, kind: "equity" }, select: { id: true } })) throw new MarketDataError("INSTRUMENT_NOT_IN_UNIVERSE");
  const snapshot = await provider.getSnapshot({ exchange: "NSE", symbol }, days);
  if (snapshot.provider !== provider.name || snapshot.instrument.exchange !== "NSE" || snapshot.instrument.symbol !== symbol || snapshot.requestedCalendarDays !== days) throw new MarketDataError("PROVIDER_SNAPSHOT_MISMATCH");
  return storeMarketSnapshot(db, snapshot);
}
