import { describe, expect, it, vi } from "vitest";
import { createYahooProvider, parseYahooSnapshot } from "../src/lib/market-data/yahoo";
import { nseProviderSymbol } from "../src/lib/market-data/provider";

const at = new Date("2026-11-03T04:30:00Z");
const seconds = (value: string) => Date.parse(value) / 1000;
const instrument = { exchange: "NSE" as const, symbol: "TCS" };
// Entirely synthetic quote/candles, not real prices or a captured Yahoo response.
function fixture() {
  return { chart: { error: null, result: [{
    meta: { symbol: "TCS.NS", currency: "INR", exchangeName: "NSI", regularMarketPrice: 101.25, regularMarketTime: seconds("2026-11-03T04:29:00Z") },
    timestamp: [seconds("2026-11-02T03:45:00Z"), seconds("2026-11-03T03:45:00Z")],
    indicators: { quote: [{ open: [99, 100], high: [102, 103], low: [98, 99], close: [100, 101], volume: [1000, 1200] }], adjclose: [{ adjclose: [99.5, 100.5] }] },
  }] } };
}

describe("experimental NSE market-data adapter", () => {
  it("normalizes NSE symbols without allowing arbitrary paths or exchanges", () => {
    expect(nseProviderSymbol({ exchange: "NSE", symbol: " tcs " })).toBe("TCS.NS");
    expect(nseProviderSymbol({ exchange: "NSE", symbol: "M&M" })).toBe("M&M.NS");
    for (const symbol of ["TCS.NS", "../TCS", "^NSEI", "", "TCS?key=x"]) expect(() => nseProviderSymbol({ exchange: "NSE", symbol })).toThrow("UNSUPPORTED_INSTRUMENT");
  });
  it("keeps quote timestamps, string prices, daily session dates and uncertainty labels", () => {
    const snapshot = parseYahooSnapshot(fixture(), instrument, 30, at);
    expect(snapshot.quote).toEqual({ price: "101.25", currency: "INR", marketTime: "2026-11-03T04:29:00.000Z", retrievedAt: at.toISOString(), ageSeconds: 60, freshness: "recent", delayStatus: "unknown" });
    expect(snapshot.candles[0]).toMatchObject({ sessionDate: "2026-11-02", open: "99", close: "100", adjustedClose: "99.5", volume: "1000", priceBasis: "provider_native_unverified", completion: "unknown" });
    expect(snapshot.candles[1].completion).toBe("unknown");
  });
  it("marks old quotes stale without substituting the most recent candle close", () => {
    const body = fixture();
    body.chart.result[0].meta.regularMarketTime = seconds("2026-11-02T10:00:00Z");
    expect(parseYahooSnapshot(body, instrument, 30, at).quote).toMatchObject({ freshness: "stale", price: "101.25" });
    const missing = fixture() as unknown as { chart: { result: { meta: Record<string, unknown> }[] } };
    delete missing.chart.result[0].meta.regularMarketTime;
    expect(parseYahooSnapshot(missing, instrument, 30, at).quote).toBeNull();
  });
  it("distinguishes small clock skew and rejects far-future data", () => {
    const body = fixture();
    body.chart.result[0].meta.regularMarketTime = at.getTime() / 1000 + 10;
    expect(parseYahooSnapshot(body, instrument, 30, at).quote?.freshness).toBe("clock_skew");
    body.chart.result[0].meta.regularMarketTime += 120;
    expect(() => parseYahooSnapshot(body, instrument, 30, at)).toThrow("FUTURE_QUOTE_TIMESTAMP");
  });
  it.each(["symbol", "currency", "exchangeName"] as const)("rejects inconsistent instrument metadata: %s", (field) => {
    const body = fixture(); body.chart.result[0].meta[field] = "OTHER";
    expect(() => parseYahooSnapshot(body, instrument, 30, at)).toThrow("INSTRUMENT_METADATA_MISMATCH");
  });
  it("skips missing or impossible OHLC values and leaves unsafe volumes unknown", () => {
    const body = fixture();
    body.chart.result[0].indicators.quote[0].low[0] = 200;
    body.chart.result[0].indicators.quote[0].volume[1] = Number.MAX_SAFE_INTEGER + 1;
    const result = parseYahooSnapshot(body, instrument, 30, at);
    expect(result.skippedBars).toBe(1);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].volume).toBeNull();
  });
  it("rejects misaligned, duplicated and future candle timestamps", () => {
    const body = fixture(); body.chart.result[0].indicators.quote[0].open.pop();
    expect(() => parseYahooSnapshot(body, instrument, 30, at)).toThrow("MISALIGNED_CANDLE_ARRAYS");
    const duplicate = fixture(); duplicate.chart.result[0].timestamp[1] = duplicate.chart.result[0].timestamp[0];
    expect(() => parseYahooSnapshot(duplicate, instrument, 30, at)).toThrow("INVALID_CANDLE_TIMESTAMP");
    const future = fixture(); future.chart.result[0].timestamp[1] = at.getTime() / 1000 + 120;
    expect(() => parseYahooSnapshot(future, instrument, 30, at)).toThrow("INVALID_CANDLE_TIMESTAMP");
  });
  it("rejects provider errors and missing results rather than pretending zero prices", () => {
    expect(() => parseYahooSnapshot({ chart: { error: { description: "secret" }, result: null } }, instrument, 30, at)).toThrow("PROVIDER_REPORTED_ERROR");
    expect(() => parseYahooSnapshot({ chart: { result: null } }, instrument, 30, at)).toThrow("NO_MARKET_DATA");
    expect(() => parseYahooSnapshot("Access denied", instrument, 30, at)).toThrow("INVALID_CHART_RESPONSE");
  });
  it("makes one bounded chart request per snapshot with an explicit daily interval", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const result = await createYahooProvider(fetcher, () => at).getSnapshot(instrument, 10);
    expect(result.quote?.price).toBe("101.25");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain("chart/TCS.NS?");
    expect(new URL(String(url)).searchParams.get("interval")).toBe("1d");
    expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });
  it("validates history bounds before making requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const days of [0, 366, 1.5, NaN]) await expect(createYahooProvider(fetcher).getSnapshot(instrument, days)).rejects.toThrow("INVALID_HISTORY_DAYS");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves safe HTTP codes and sanitizes network/JSON errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret body", { status: 429 }));
    const provider = createYahooProvider(fetcher, () => at);
    await expect(provider.getSnapshot(instrument)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR", httpStatus: 429 });
    fetcher.mockRejectedValue(new Error("proxy secret"));
    await expect(provider.getSnapshot(instrument)).rejects.toThrow("PROVIDER_NETWORK_ERROR");
    fetcher.mockResolvedValue(new Response("not JSON secret"));
    await expect(provider.getSnapshot(instrument)).rejects.toThrow("INVALID_PROVIDER_JSON");
    fetcher.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(provider.getSnapshot(instrument)).rejects.toThrow("PROVIDER_RESPONSE_TOO_LARGE");
  });
});
