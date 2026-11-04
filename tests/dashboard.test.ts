import { describe, expect, it, vi } from "vitest";
import { collectionState, inboxFiltersSchema, loadRead, safeSourceUrl, stringList } from "../src/lib/dashboard/queries";
import { readWorkerStatus } from "../src/lib/dashboard/worker";
describe("dashboard safety and honest state", () => {
  it("validates bounded filters and rejects query injection strings and array parameters", () => {
    expect(inboxFiltersSchema.parse({ stock: " tcs " }).stock).toBe("TCS");
    for (const input of [{ page: 0 }, { page: 201 }, { stock: "' OR 1=1 --" }, { kind: ["all"] }, { classification: "BUY" }]) expect(inboxFiltersSchema.safeParse(input).success).toBe(false);
  });
  it("does not turn missing or future source timestamps into fresh data", () => {
    const at = new Date("2026-11-03T05:00:00Z");
    expect(collectionState(null, at)).toBe("unknown");
    expect(collectionState(new Date("2026-11-03T06:00:00Z"), at)).toBe("unknown");
    expect(collectionState(new Date("2026-11-03T04:00:00Z"), at)).toBe("recent");
    expect(collectionState(new Date("2026-11-03T02:00:00Z"), at)).toBe("stale");
  });
  it("keeps source URLs safe and malformed JSON fields out of rendered lists", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,test", "https://user:secret@example.com", null, "invalid"]) expect(safeSourceUrl(url)).toBeNull();
    expect(safeSourceUrl("https://example.com/filing")).toBe("https://example.com/filing");
    expect(stringList(["Risk", { html: "<script>" }, 1])).toEqual(["Risk"]);
  });
  it("returns a distinct unavailable state without exposing database exception text", async () => {
    const result = await loadRead(async () => { throw new Error("secret-database-url"); });
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("distinguishes degraded worker responses from unreachable or unrelated services", async () => {
    const runtime = { checks: { database: "up", jobs: "down", scheduler: "disabled" }, lastJobPollAt: null, lastSchedulerTickAt: null };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ service: "swing-worker", status: "degraded", runtime }), { status: 503 }));
    expect((await readWorkerStatus("http://127.0.0.1:3001", fetcher)).state).toBe("degraded");
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "error", cache: "no-store" }));
    fetcher.mockRejectedValueOnce(new Error("connection refused"));
    expect((await readWorkerStatus("http://127.0.0.1:3001", fetcher)).state).toBe("unavailable");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ service: "another-app", status: "ok" })));
    expect((await readWorkerStatus("http://127.0.0.1:3001", fetcher)).state).toBe("unavailable");
  });
});
