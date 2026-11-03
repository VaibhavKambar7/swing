import { describe, expect, it } from "vitest";
import { normalizeMarketSnapshot } from "../src/lib/market-data/persist";
import { parsePriceArgs } from "../src/lib/market-data/provider";

import { syntheticSnapshot } from "./fixtures/market-snapshot";

describe("market observation validation", () => {
  it("normalizes equivalent decimals and keeps unknown metadata", () => {
    const snapshot = syntheticSnapshot(); snapshot.candles[0].open = "99.000";
    expect(normalizeMarketSnapshot(snapshot).candles[0]).toMatchObject({ open: "99", volume: null, adjustedClose: null, completion: "unknown" });
  });
  it.each(["0", "-1", "NaN", "Infinity", "1e1000", "1e-19", "100.1234567890123456789"])("rejects invalid or unrepresentable prices without rounding: %s", (price) => {
    const snapshot = syntheticSnapshot(); snapshot.quote!.price = price;
    expect(() => normalizeMarketSnapshot(snapshot)).toThrow();
  });
  it("rejects inconsistent quote freshness or retrieval times", () => {
    const snapshot = syntheticSnapshot(); snapshot.quote!.freshness = "stale";
    expect(() => normalizeMarketSnapshot(snapshot)).toThrow("INCONSISTENT_QUOTE_FRESHNESS");
    snapshot.quote!.freshness = "recent"; snapshot.quote!.retrievedAt = "2026-11-03T04:31:00.000Z";
    expect(() => normalizeMarketSnapshot(snapshot)).toThrow("INCONSISTENT_QUOTE_FRESHNESS");
  });
  it("rejects impossible bars, duplicate sessions and volume overflow", () => {
    const bad = syntheticSnapshot(); bad.candles[0].low = "200";
    expect(() => normalizeMarketSnapshot(bad)).toThrow("INVALID_CANDLE_OHLC");
    const duplicate = syntheticSnapshot(); duplicate.candles.push({ ...duplicate.candles[0] });
    expect(() => normalizeMarketSnapshot(duplicate)).toThrow("INVALID_CANDLE_SESSION");
    const volume = syntheticSnapshot(); volume.candles[0].volume = "9223372036854775808";
    expect(() => normalizeMarketSnapshot(volume)).toThrow("VOLUME_OVERFLOW");
  });
  it("validates source identity and CLI arguments", () => {
    const snapshot = syntheticSnapshot(); snapshot.providerSymbol = "OTHER.NS";
    expect(() => normalizeMarketSnapshot(snapshot)).toThrow("INSTRUMENT_METADATA_MISMATCH");
    expect(parsePriceArgs([" tcs ", "--days", "5"])).toEqual({ instrument: { exchange: "NSE", symbol: "TCS" }, days: 5 });
    for (const args of [[], ["TCS", "--days"], ["TCS", "--days", "0"], ["TCS", "--days", "2.5"], ["TCS", "--unexpected", "1"]]) expect(() => parsePriceArgs(args)).toThrow();
  });
});
