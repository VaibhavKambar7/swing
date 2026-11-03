import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client";
import { evaluateMovement } from "../src/lib/market-data/detect";
import { parseCalendar } from "../src/lib/market/calendar";

const calendar = parseCalendar({ source: "Synthetic unit-test sessions", coverageStart: "2026-11-02", coverageEnd: "2026-11-04", holidays: [], specialSessions: [] });
const at = new Date("2026-11-03T04:30:00Z");
function observation(price: string, time = "2026-11-03T04:30:00Z") {
  return { id: time, instrumentId: "stock-1", provider: "yahoo-experimental", providerSymbol: "TCS.NS", currency: "INR",
    quotePrice: new Prisma.Decimal(price), quoteTime: new Date(time), retrievedAt: new Date(time), quoteFreshness: "recent", quoteDelayStatus: "unknown" };
}
const baseline = () => observation("100", "2026-11-03T04:25:00Z");

describe("same-session movement detector", () => {
  it.each([["102", "2.00000000", "up"], ["98", "-2.00000000", "down"]])("includes the 2%% threshold for %s", (price, changePct, direction) => {
    expect(evaluateMovement(observation(price), baseline(), calendar, at)).toEqual({ status: "movement", changePct, direction });
  });
  it("compares precise decimals before rounding the reported percentage", () => {
    expect(evaluateMovement(observation("101.999999999999999999"), baseline(), calendar, at)).toEqual({ status: "skipped", reason: "BELOW_THRESHOLD" });
  });
  it("recomputes staleness instead of trusting a historical recent label", () => {
    expect(evaluateMovement(observation("103"), baseline(), calendar, new Date("2026-11-03T04:35:00.001Z"))).toEqual({ status: "skipped", reason: "STALE_CURRENT_QUOTE" });
  });
  it("rejects missing, future and incompatible observations", () => {
    expect(evaluateMovement(null, baseline(), calendar, at)).toMatchObject({ reason: "NO_CURRENT_QUOTE" });
    expect(evaluateMovement(observation("103", "2026-11-03T04:31:00Z"), baseline(), calendar, at)).toMatchObject({ reason: "FUTURE_OBSERVATION" });
    expect(evaluateMovement(observation("103"), { ...baseline(), provider: "another-provider" }, calendar, at)).toMatchObject({ reason: "INCOMPATIBLE_OBSERVATIONS" });
  });
  it("rejects stale-at-retrieval references and source gaps outside five to six minutes", () => {
    expect(evaluateMovement(observation("103"), { ...baseline(), quoteFreshness: "stale" }, calendar, at)).toMatchObject({ reason: "INVALID_REFERENCE_FRESHNESS" });
    for (const time of ["2026-11-03T04:26:00Z", "2026-11-03T04:23:59Z"]) expect(evaluateMovement(observation("103"), observation("100", time), calendar, at)).toMatchObject({ reason: "REFERENCE_OUTSIDE_WINDOW" });
    expect(evaluateMovement(observation("103"), observation("100", "2026-11-03T04:24:00Z"), calendar, at).status).toBe("movement");
  });
  it("rejects overnight baselines, closed sessions and unknown calendar coverage", () => {
    expect(evaluateMovement(observation("103"), observation("100", "2026-11-02T10:00:00Z"), calendar, at)).toMatchObject({ reason: "REFERENCE_OUTSIDE_SESSION" });
    expect(evaluateMovement(observation("103"), baseline(), calendar, new Date("2026-11-03T10:00:00Z"))).toMatchObject({ reason: "MARKET_CLOSED" });
    expect(evaluateMovement(observation("103"), baseline(), calendar, new Date("2027-01-01"))).toMatchObject({ reason: "CALENDAR_COVERAGE_REQUIRED" });
  });
  it("rejects percentages that cannot fit the stored metric", () => {
    expect(evaluateMovement(observation("10000000000000000000"), observation("0.000000000000000001", "2026-11-03T04:25:00Z"), calendar, at)).toMatchObject({ reason: "CHANGE_OUT_OF_RANGE" });
  });
});
