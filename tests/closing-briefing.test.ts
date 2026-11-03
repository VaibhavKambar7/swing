import { describe, expect, it } from "vitest";
import { closingWindow, planClosingBriefing } from "../src/lib/briefings/closing";
import { parseCalendar } from "../src/lib/market/calendar";
import { parseEnv } from "../src/lib/config/env";

const calendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-02", coverageEnd: "2026-11-09",
  holidays: [{ date: "2026-11-04", name: "Synthetic holiday" }],
  specialSessions: [
    { date: "2026-11-07", name: "Synthetic evening", sessions: [{ open: "18:00", close: "19:00" }] },
    { date: "2026-11-05", name: "Synthetic late session", sessions: [{ open: "23:00", close: "23:50" }] },
  ],
});

describe("closing summary calendar", () => {
  it("is due at 15:45 IST for regular sessions and catches up later that date", () => {
    expect(planClosingBriefing(calendar, new Date("2026-11-03T15:44:59+05:30")).status).toBe("skipped");
    expect(planClosingBriefing(calendar, new Date("2026-11-03T15:45:00+05:30"))).toMatchObject({ status: "due", sessionDate: "2026-11-03", cutoffAt: new Date("2026-11-03T10:15:00Z") });
    expect(planClosingBriefing(calendar, new Date("2026-11-03T23:00:00+05:30")).status).toBe("due");
    expect(planClosingBriefing(calendar, new Date("2026-11-04T00:00:00+05:30")).status).toBe("skipped");
  });
  it("waits fifteen minutes after a special-session close", () => {
    expect(closingWindow(calendar, "2026-11-07").cutoffAt).toEqual(new Date("2026-11-07T19:15:00+05:30"));
    expect(planClosingBriefing(calendar, new Date("2026-11-07T19:14:59+05:30")).status).toBe("skipped");
    expect(planClosingBriefing(calendar, new Date("2026-11-07T19:15:00+05:30")).status).toBe("due");
  });
  it("retains the correct trading date when a late-session cutoff crosses midnight", () => {
    expect(closingWindow(calendar, "2026-11-05").cutoffAt).toEqual(new Date("2026-11-06T00:05:00+05:30"));
    expect(planClosingBriefing(calendar, new Date("2026-11-06T00:04:59+05:30")).status).toBe("skipped");
    expect(planClosingBriefing(calendar, new Date("2026-11-06T00:05:00+05:30"))).toMatchObject({ status: "due", sessionDate: "2026-11-05" });
  });
  it("does not invent holiday/weekend sessions or unknown coverage", () => {
    expect(() => closingWindow(calendar, "2026-11-04")).toThrow("NOT_A_TRADING_DAY");
    expect(planClosingBriefing(calendar, new Date("2026-11-08T15:45:00+05:30")).status).toBe("skipped");
    expect(() => planClosingBriefing(calendar, new Date("2027-01-01"))).toThrow("CALENDAR_COVERAGE_REQUIRED");
  });
  it("is opt-in independently from morning reports", () => {
    const base = { DATABASE_URL: "postgresql://localhost/swing" };
    expect(parseEnv(base).WORKER_CLOSING_BRIEFING_ENABLED).toBe(false);
    expect(parseEnv({ ...base, WORKER_CLOSING_BRIEFING_ENABLED: "true" }).WORKER_CLOSING_BRIEFING_ENABLED).toBe(true);
  });
});
