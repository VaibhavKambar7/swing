import { describe, expect, it } from "vitest";
import { morningWindow, planMorningBriefing } from "../src/lib/briefings/morning";
import { parseCalendar } from "../src/lib/market/calendar";
import { parseEnv } from "../src/lib/config/env";

const calendar = parseCalendar({ source: "Synthetic calendar only", coverageStart: "2026-10-30", coverageEnd: "2026-11-09",
  holidays: [{ date: "2026-11-04", name: "Synthetic holiday" }],
  specialSessions: [
    { date: "2026-11-05", name: "Synthetic early opening", sessions: [{ open: "08:00", close: "10:00" }] },
    { date: "2026-11-07", name: "Synthetic evening session", sessions: [{ open: "18:00", close: "19:00" }] },
  ],
});

describe("morning briefing schedule", () => {
  it("is due at 08:45 IST and catches up only before opening", () => {
    expect(planMorningBriefing(calendar, new Date("2026-11-03T08:44:59+05:30"))).toMatchObject({ status: "skipped", reason: "NOT_DUE" });
    expect(planMorningBriefing(calendar, new Date("2026-11-03T08:45:00+05:30"))).toMatchObject({ status: "due", sessionDate: "2026-11-03" });
    expect(planMorningBriefing(calendar, new Date("2026-11-03T09:14:59+05:30")).status).toBe("due");
    expect(planMorningBriefing(calendar, new Date("2026-11-03T09:15:00+05:30"))).toMatchObject({ status: "skipped", reason: "PREMARKET_WINDOW_CLOSED" });
  });
  it("skips nontrading dates and early sessions but honors evening weekend sessions", () => {
    expect(planMorningBriefing(calendar, new Date("2026-11-01T08:45:00+05:30"))).toMatchObject({ reason: "NOT_A_TRADING_DAY" });
    expect(planMorningBriefing(calendar, new Date("2026-11-04T08:45:00+05:30"))).toMatchObject({ reason: "NOT_A_TRADING_DAY" });
    expect(planMorningBriefing(calendar, new Date("2026-11-05T08:45:00+05:30"))).toMatchObject({ reason: "SESSION_OPENS_BEFORE_BRIEFING" });
    expect(planMorningBriefing(calendar, new Date("2026-11-07T08:45:00+05:30")).status).toBe("due");
  });
  it("includes the full weekend since the previous trading close", () => {
    expect(morningWindow(calendar, "2026-11-02")).toMatchObject({ windowStart: new Date("2026-10-30T10:00:00Z"), cutoffAt: new Date("2026-11-02T03:15:00Z"), windowBasis: "previous_session_close" });
  });
  it("labels an explicit fallback when previous-session coverage is unavailable", () => {
    expect(morningWindow(calendar, "2026-10-30").windowBasis).toBe("fallback_24h_calendar_incomplete");
    expect(() => planMorningBriefing(calendar, new Date("2027-01-01"))).toThrow("CALENDAR_COVERAGE_REQUIRED");
  });
  it("keeps scheduled briefing generation opt-in", () => {
    const base = { DATABASE_URL: "postgresql://localhost/swing" };
    expect(parseEnv(base).WORKER_MORNING_BRIEFING_ENABLED).toBe(false);
    expect(parseEnv({ ...base, WORKER_MORNING_BRIEFING_ENABLED: "true" }).WORKER_MORNING_BRIEFING_ENABLED).toBe(true);
    expect(() => parseEnv({ ...base, WORKER_MORNING_BRIEFING_ENABLED: "yes" })).toThrow("WORKER_MORNING_BRIEFING_ENABLED");
  });
});
