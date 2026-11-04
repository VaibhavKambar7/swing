export type MarketInstrument = { exchange: "NSE"; symbol: string };
export type MarketQuote = {
  price: string; currency: "INR"; marketTime: string; retrievedAt: string;
  ageSeconds: number; freshness: "recent" | "stale" | "clock_skew";
  delayStatus: "unknown";
};
export type MarketCandle = {
  sessionDate: string; timestamp: string;
  open: string; high: string; low: string; close: string;
  volume: string | null; adjustedClose: string | null;
  priceBasis: "provider_native_unverified"; completion: "unknown";
};
export type MarketSnapshot = {
  provider: string; instrument: MarketInstrument; providerSymbol: string;
  retrievedAt: string; requestedCalendarDays: number;
  quote: MarketQuote | null; candles: MarketCandle[]; skippedBars: number;
};
export type MarketDataProvider = {
  name: string;
  getSnapshot(instrument: MarketInstrument, calendarDays?: number, signal?: AbortSignal): Promise<MarketSnapshot>;
};
export class MarketDataError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    super(`Market data failed: ${code}`);
  }
}

export function nseProviderSymbol(instrument: MarketInstrument) {
  const symbol = instrument.symbol.trim().toUpperCase();
  if (instrument.exchange !== "NSE" || !/^[A-Z0-9][A-Z0-9&-]{0,29}$/.test(symbol)) throw new MarketDataError("UNSUPPORTED_INSTRUMENT");
  return `${symbol}.NS`;
}

export function validateHistoryDays(days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new MarketDataError("INVALID_HISTORY_DAYS");
}

export function parsePriceArgs(args: string[]) {
  const [symbol, flag, value, ...extra] = args;
  if (!symbol || extra.length || (flag !== undefined && (flag !== "--days" || !value || !/^\d+$/.test(value)))) throw new MarketDataError("INVALID_ARGUMENTS");
  const days = value === undefined ? 30 : Number(value);
  validateHistoryDays(days);
  const instrument: MarketInstrument = { exchange: "NSE", symbol: symbol.trim().toUpperCase() };
  nseProviderSymbol(instrument);
  return { instrument, days };
}
