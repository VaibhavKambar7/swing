import { z } from "zod";
import { marketDate } from "../market/calendar";
import { MarketDataError, nseProviderSymbol, validateHistoryDays, type MarketInstrument, type MarketSnapshot, type MarketDataProvider, type MarketCandle } from "./provider";

const values = z.array(z.number().nullable()).max(2000);
const chartSchema = z.object({ chart: z.object({
  error: z.unknown().optional(),
  result: z.array(z.object({
    meta: z.object({ symbol: z.string(), currency: z.string(), exchangeName: z.string(),
      regularMarketPrice: z.number().nullable().optional(), regularMarketTime: z.number().nullable().optional() }),
    timestamp: z.array(z.number()).max(2000).optional(),
    indicators: z.object({
      quote: z.array(z.object({ open: values, high: values, low: values, close: values, volume: values.optional() })).length(1),
      adjclose: z.array(z.object({ adjclose: values })).max(1).optional(),
    }).optional(),
  })).max(1).nullable(),
}) });

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function instant(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) throw new MarketDataError("INVALID_SOURCE_TIMESTAMP");
  return new Date(seconds * 1000);
}

export function parseYahooSnapshot(
  body: unknown, instrument: MarketInstrument, days: number, retrievedAt: Date, maxQuoteAgeSeconds = 300,
): MarketSnapshot {
  validateHistoryDays(days);
  const providerSymbol = nseProviderSymbol(instrument);
  if (!Number.isFinite(retrievedAt.getTime()) || !Number.isFinite(maxQuoteAgeSeconds) || maxQuoteAgeSeconds <= 0) throw new MarketDataError("INVALID_PROVIDER_OPTIONS");
  const parsed = chartSchema.safeParse(body);
  if (!parsed.success) throw new MarketDataError("INVALID_CHART_RESPONSE");
  if (parsed.data.chart.error != null) throw new MarketDataError("PROVIDER_REPORTED_ERROR");
  const chart = parsed.data.chart.result?.[0];
  if (!chart) throw new MarketDataError("NO_MARKET_DATA");
  if (chart.meta.symbol.toUpperCase() !== providerSymbol || chart.meta.currency !== "INR" || !["NSI", "NSE"].includes(chart.meta.exchangeName)) throw new MarketDataError("INSTRUMENT_METADATA_MISMATCH");
  let quote: MarketSnapshot["quote"] = null;
  if (positive(chart.meta.regularMarketPrice) && chart.meta.regularMarketTime != null) {
    const time = instant(chart.meta.regularMarketTime);
    const ageSeconds = (retrievedAt.getTime() - time.getTime()) / 1000;
    if (ageSeconds < -60) throw new MarketDataError("FUTURE_QUOTE_TIMESTAMP");
    quote = {
      price: String(chart.meta.regularMarketPrice), currency: "INR", marketTime: time.toISOString(),
      retrievedAt: retrievedAt.toISOString(), ageSeconds,
      freshness: ageSeconds < 0 ? "clock_skew" : ageSeconds > maxQuoteAgeSeconds ? "stale" : "recent",
      delayStatus: "unknown",
    };
  }
  const candles: MarketCandle[] = [];
  let skippedBars = 0;
  if (!chart.timestamp?.length && chart.indicators?.quote[0]?.close.length) throw new MarketDataError("MISALIGNED_CANDLE_ARRAYS");
  if ((chart.timestamp?.length ?? 0) > 0) {
    const bars = chart.indicators?.quote[0];
    const adjusted = chart.indicators?.adjclose?.[0]?.adjclose;
    const length = chart.timestamp!.length;
    if (!bars || [bars.open, bars.high, bars.low, bars.close, bars.volume, adjusted].some((column) => column && column.length !== length)) throw new MarketDataError("MISALIGNED_CANDLE_ARRAYS");
    let previous = 0;
    const sessionDates = new Set<string>();
    for (let i = 0; i < length; i++) {
      const timestamp = chart.timestamp![i];
      const time = instant(timestamp);
      if (timestamp <= previous || time.getTime() > retrievedAt.getTime() + 60000) throw new MarketDataError("INVALID_CANDLE_TIMESTAMP");
      previous = timestamp;
      const open = bars.open[i], high = bars.high[i], low = bars.low[i], close = bars.close[i];
      if (!positive(open) || !positive(high) || !positive(low) || !positive(close) || low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
        skippedBars++; continue;
      }
      const volume = bars.volume?.[i];
      const sessionDate = marketDate(time);
      if (sessionDates.has(sessionDate)) throw new MarketDataError("DUPLICATE_DAILY_SESSION");
      sessionDates.add(sessionDate);
      candles.push({ sessionDate, timestamp: time.toISOString(), open: String(open), high: String(high), low: String(low), close: String(close),
        volume: typeof volume === "number" && Number.isSafeInteger(volume) && volume >= 0 ? String(volume) : null,
        adjustedClose: positive(adjusted?.[i]) ? String(adjusted![i]) : null,
        priceBasis: "provider_native_unverified", completion: "unknown" });
    }
  }
  return { provider: "yahoo-experimental", instrument: { exchange: "NSE", symbol: providerSymbol.slice(0, -3) }, providerSymbol,
    retrievedAt: retrievedAt.toISOString(), requestedCalendarDays: days, quote, candles, skippedBars };
}

export function createYahooProvider(fetcher: typeof fetch = fetch, clock: () => Date = () => new Date()): MarketDataProvider {
  return {
    name: "yahoo-experimental",
    async getSnapshot(instrument, days = 30) {
      const symbol = nseProviderSymbol(instrument);
      validateHistoryDays(days);
      const requestedAt = clock();
      if (!Number.isFinite(requestedAt.getTime())) throw new MarketDataError("INVALID_PROVIDER_OPTIONS");
      const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
      url.search = new URLSearchParams({ interval: "1d", period1: String(Math.floor(requestedAt.getTime() / 1000) - days * 86400),
        period2: String(Math.floor(requestedAt.getTime() / 1000)), includeAdjustedClose: "true" }).toString();
      try {
        const response = await fetcher(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new MarketDataError("PROVIDER_HTTP_ERROR", response.status);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new MarketDataError("EMPTY_PROVIDER_RESPONSE");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024) throw new MarketDataError("PROVIDER_RESPONSE_TOO_LARGE");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        return parseYahooSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")), instrument, days, clock());
      } catch (error) {
        if (error instanceof MarketDataError) throw error;
        throw new MarketDataError(error instanceof SyntaxError ? "INVALID_PROVIDER_JSON" : "PROVIDER_NETWORK_ERROR");
      }
    },
  };
}
