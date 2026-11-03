import type { MarketSnapshot } from "../../src/lib/market-data/provider";

// Synthetic values only, not actual stock prices.
export function syntheticSnapshot(): MarketSnapshot {
  return {
    provider: "yahoo-experimental", providerSymbol: "TCS.NS", instrument: { exchange: "NSE", symbol: "TCS" },
    retrievedAt: "2026-11-03T04:30:00.000Z", requestedCalendarDays: 30, skippedBars: 0,
    quote: { price: "101.123456789012345678", currency: "INR", marketTime: "2026-11-03T04:29:00.000Z", retrievedAt: "2026-11-03T04:30:00.000Z", ageSeconds: 60, freshness: "recent", delayStatus: "unknown" },
    candles: [{ sessionDate: "2026-11-02", timestamp: "2026-11-02T03:45:00.000Z", open: "99", high: "102", low: "98", close: "100", adjustedClose: null, volume: null, priceBasis: "provider_native_unverified", completion: "unknown" }],
  };
}

