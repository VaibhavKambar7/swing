import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client";
import { evaluatePostOpen, planPostOpen, postOpenWindow } from "../src/lib/briefings/post-open";
import { parseCalendar } from "../src/lib/market/calendar";

const calendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-02", coverageEnd: "2026-11-08", holidays: [], specialSessions: [
  { date: "2026-11-07", name: "Synthetic evening session", sessions: [{ open: "18:00", close: "19:00" }] },
] });
const window = postOpenWindow(calendar, "2026-11-03");
const at = new Date("2026-11-03T03:50:10Z");
const quote = (price: string, time = "2026-11-03T03:50:00Z") => ({ id: time, instrumentId: "stock", provider: "yahoo-experimental", providerSymbol: "TCS.NS", currency: "INR", quotePrice: new Prisma.Decimal(price), quoteTime: new Date(time), retrievedAt: new Date(time), quoteFreshness: "recent" });
const opening = () => quote("100", "2026-11-03T03:45:20Z");

describe("post-open research rules", () => {
  it("schedules minute slots from 09:20 inclusive to 09:30 exclusive", () => {
    expect(planPostOpen(calendar, new Date("2026-11-03T03:49:59Z")).status).toBe("skipped");
    const first = planPostOpen(calendar, new Date("2026-11-03T03:50:00Z"));
    expect(first.status).toBe("due");
    expect(planPostOpen(calendar, new Date("2026-11-03T03:50:59Z"))).toEqual(first);
    expect(planPostOpen(calendar, new Date("2026-11-03T03:51:00Z"))).not.toEqual(first);
    expect(planPostOpen(calendar, new Date("2026-11-03T04:00:00Z")).status).toBe("skipped");
    expect(planPostOpen(calendar, new Date("2026-11-07T18:05:00+05:30")).status).toBe("due");
    expect(planPostOpen(calendar, new Date("2026-11-08T09:20:00+05:30")).status).toBe("skipped");
  });
  it("uses caution for rapid rises/falls and watch for smaller observed moves", () => {
    expect(evaluatePostOpen(quote("105"), opening(), window, at)).toMatchObject({ status: "CAUTION", reason: "RAPID_POST_OPEN_RISE", changeSinceObservedOpenPct: "5.00000000" });
    expect(evaluatePostOpen(quote("95"), opening(), window, at)).toMatchObject({ status: "CAUTION", reason: "RAPID_POST_OPEN_FALL" });
    expect(evaluatePostOpen(quote("104.999999999999999999"), opening(), window, at).status).toBe("WATCH");
  });
  it("does not turn stale/missing/future quotes into an actionable assessment", () => {
    expect(evaluatePostOpen(null, opening(), window, at)).toMatchObject({ status: "PENDING_DATA", reason: "CURRENT_QUOTE_MISSING" });
    expect(evaluatePostOpen(quote("105", "2026-11-03T03:47:00Z"), opening(), window, at)).toMatchObject({ reason: "CURRENT_QUOTE_STALE" });
    expect(evaluatePostOpen(quote("105", "2026-11-03T03:51:00Z"), opening(), window, at)).toMatchObject({ reason: "FUTURE_OR_SKEWED_QUOTE" });
    expect(evaluatePostOpen(quote("105"), null, window, at)).toMatchObject({ reason: "OPENING_OBSERVATION_MISSING" });
  });
  it("rejects incompatible sources, invalid opening observations and expired windows", () => {
    expect(evaluatePostOpen(quote("105"), { ...opening(), provider: "other" }, window, at)).toMatchObject({ reason: "INCOMPATIBLE_OBSERVATIONS" });
    expect(evaluatePostOpen(quote("105"), quote("100", "2026-11-03T03:47:00Z"), window, at)).toMatchObject({ reason: "OPENING_OBSERVATION_UNRELIABLE" });
    expect(evaluatePostOpen(quote("105"), opening(), window, new Date("2026-11-03T04:00:00Z"))).toMatchObject({ reason: "OUTSIDE_REASSESSMENT_WINDOW" });
  });
});
