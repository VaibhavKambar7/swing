import { describe, expect, it, vi } from "vitest";
import { universeSchema, parseConstituentCsv } from "../src/lib/instruments/universe";
import { createSourceAdapter, parseBse } from "../src/lib/announcements/sources";
import { percentageChange, volatilityComparison } from "../src/lib/market-data/context";
import { retryAfterMs } from "../src/lib/network/rate-limit";
import { createMarketProvider } from "../src/lib/market-data/registry";
import { priceSymbolsSchema } from "../src/lib/market-data/scheduler";
import { matchAnnouncement } from "../src/lib/announcements/match";
describe("maintained universe and market context", () => {
  it("imports quoted official CSV without inventing mappings", () => {
    const value = parseConstituentCsv('Company Name,Industry,Symbol,ISIN Code\n"Example, Limited",IT,EXAMPLE,INE000000001\n', "official supplied file", "2026-11-04");
    expect(value.members[0]).toMatchObject({ name: "Example, Limited", symbol: "EXAMPLE", benchmark: null });
    expect(() => parseConstituentCsv('a,b\nx,y', "source", "2026-11-04")).toThrow();
  });
  it("rejects ambiguous constituents, invalid dates, and non-index mappings", () => {
    const m = { symbol: "EXAMPLE", name: "Example" };
    for (const input of [{ members: [m, m] }, { members: [{ ...m, benchmark: "OTHER" }] }, { effectiveDate: "2026-02-30", members: [m] }]) expect(universeSchema.safeParse({ source: "source", effectiveDate: "2026-11-04", ...input }).success).toBe(false);
    expect(priceSymbolsSchema.parse(Array.from({ length: 500 }, (_, i) => `S${i}`))).toHaveLength(500);
  });
  it("does not split a hyphenated issuer symbol", () => {
    expect(matchAnnouncement("BAJAJ-AUTO - Results", [{ id: "b", symbol: "BAJAJ-AUTO", name: "Bajaj Auto Limited" }])).toEqual({ status: "matched", instrumentId: "b" });
  });
  it("requires meaningful prior same-window volatility rather than substituting daily changes", () => {
    expect(percentageChange("100", "102")).toBe("2.00000000");
    expect(percentageChange("0", "102")).toBeNull();
    expect(volatilityComparison([1], 2, 1).status).toBe("unavailable");
    expect(volatilityComparison(Array(20).fill(1), 2, 5).status).toBe("unavailable");
    expect(volatilityComparison(Array.from({ length: 20 }, (_, i) => i / 10), 3, 5).status).toBe("observed");
  });
  it("keeps Kite an explicit deferral and handles bounded provider cooldowns", () => {
    expect(() => createMarketProvider("kite")).toThrow("KITE_INTEGRATION_DEFERRED");
    expect(retryAfterMs("60")).toBe(60000);
    expect(retryAfterMs("999999")).toBe(3600000);
    expect(retryAfterMs("invalid")).toBe(0);
  });
});
describe("source request and response boundaries", () => {
  it("parses BSE timestamps as IST, retains unknown dates and rejects attachment paths", () => {
    const parsed = parseBse({ Table: [{ NEWSID: "1", SCRIP_CD: 500001, NEWSSUB: "Results", DT_TM: "2026-11-04T10:00:00", ATTACHMENTNAME: "../secret.pdf" }, { NEWSID: "2", SCRIP_CD: "500002", NEWSSUB: "Update" }] });
    expect(parsed[0].publishedAt?.toISOString()).toBe("2026-11-04T04:30:00.000Z");
    expect(parsed[0].issuerCode).toBe("500001");
    expect(parsed[0].url).not.toContain("secret");
    expect(parsed[1].publishedAt).toBeNull();
    expect(() => parseBse({ error: "blocked" })).toThrow();
  });
  it("sends real bounded BSE requests and fails on provider errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ Table: [] })));
    const source = { id: "bse", kind: "bse", name: "BSE", query: null, enabled: true, updatedAt: new Date() };
    expect((await createSourceAdapter(fetcher, () => new Date("2026-11-04T05:00:00Z")).fetch(source)).items).toEqual([]);
    const url = fetcher.mock.calls[0][0] as URL;
    expect(url.hostname).toBe("api.bseindia.com");
    expect(url.searchParams.get("strPrevDate")).toBe("20261104");
    fetcher.mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    await expect(createSourceAdapter(fetcher).fetch(source)).rejects.toMatchObject({ code: "bse_http_error" });
  });
  it("encodes a configured external search query without accepting arbitrary endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<rss><channel><title>Synthetic empty feed</title></channel></rss>"));
    await createSourceAdapter(fetcher).fetch({ id: "test", kind: "news-search", query: "TCS results & profit", name: "news", enabled: true, updatedAt: new Date() });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.hostname).toBe("news.google.com");
    expect(url.searchParams.get("q")).toBe("TCS results & profit");
  });
});
