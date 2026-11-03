import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getMarketDay, getMarketState, marketDate, parseCalendar } from "../src/lib/market/calendar";
import { loadMarketCalendar, parseCalendarArgs } from "../src/lib/market/load-calendar";

const run = promisify(execFile);
// Synthetic dates and events: no assertion about the actual exchange calendar.
const input = {
  source: "Synthetic unit-test calendar, not official exchange data",
  coverageStart: "2026-10-30", coverageEnd: "2026-11-10",
  holidays: [{ date: "2026-11-04", name: "Synthetic holiday" }],
  specialSessions: [
    { date: "2026-11-05", name: "Synthetic closure", sessions: [] },
    { date: "2026-11-07", name: "Synthetic Saturday sessions", sessions: [{ open: "10:00", close: "11:00" }, { open: "18:00", close: "19:00" }] },
  ],
};
const calendar = parseCalendar(input);
const stateAt = (value: string) => getMarketState(calendar, new Date(value));

describe("Indian equity calendar", () => {
  it.each([
    ["2026-11-03T09:14:59.999+05:30", "before_open"],
    ["2026-11-03T09:15:00+05:30", "open"],
    ["2026-11-03T15:29:59.999+05:30", "open"],
    ["2026-11-03T15:30:00+05:30", "after_close"],
  ])("treats open as inclusive and close as exclusive: %s", (instant, status) => {
    expect(stateAt(instant).status).toBe(status);
  });
  it("uses the IST date across UTC midnight and ignores host timezone", () => {
    expect(marketDate(new Date("2026-11-02T18:30:00Z"))).toBe("2026-11-03");
    expect(stateAt("2026-11-03T03:45:00Z")).toMatchObject({ timezone: "Asia/Kolkata", localDate: "2026-11-03", status: "open" });
  });
  it("closes weekends, configured holidays, and explicit special closures", () => {
    expect(getMarketDay(calendar, "2026-11-01")).toMatchObject({ kind: "weekend", sessions: [] });
    expect(stateAt("2026-11-04T12:00:00+05:30")).toMatchObject({ dayKind: "holiday", isTradingDay: false, status: "closed" });
    expect(stateAt("2026-11-05T12:00:00+05:30")).toMatchObject({ dayKind: "special", isTradingDay: false, status: "closed" });
  });
  it("supports multiple sessions on a weekend and a closed gap between them", () => {
    expect(stateAt("2026-11-07T10:30:00+05:30")).toMatchObject({ status: "open", dayKind: "special", isTradingDay: true });
    expect(stateAt("2026-11-07T11:00:00+05:30")).toMatchObject({ status: "between_sessions", currentSession: null, nextSession: { open: "18:00" } });
    expect(stateAt("2026-11-07T18:00:00+05:30").status).toBe("open");
    expect(stateAt("2026-11-07T19:00:00+05:30").status).toBe("after_close");
  });
  it("lets an explicit special session override a holiday", () => {
    const override = parseCalendar({ ...input, specialSessions: [{ date: "2026-11-04", name: "Override", sessions: [{ open: "18:00", close: "19:00" }] }] });
    expect(getMarketState(override, new Date("2026-11-04T18:15:00+05:30"))).toMatchObject({ status: "open", dayKind: "special" });
  });
  it("finds the next session across weekends and consecutive closures", () => {
    expect(stateAt("2026-10-30T15:30:00+05:30").nextSession).toMatchObject({ date: "2026-11-02", opensAt: "2026-11-02T03:45:00.000Z" });
    expect(stateAt("2026-11-03T15:30:00+05:30").nextSession).toMatchObject({ date: "2026-11-06" });
    expect(stateAt("2026-11-06T15:30:00+05:30").nextSession).toMatchObject({ date: "2026-11-07", open: "10:00" });
  });
  it("does not invent a session beyond configured coverage", () => {
    expect(stateAt("2026-11-11T12:00:00+05:30")).toMatchObject({ status: "unknown", isTradingDay: null, nextSession: null });
    expect(stateAt("2026-11-10T15:30:00+05:30")).toMatchObject({ status: "after_close", nextSession: null, nextSessionUnavailableReason: "CALENDAR_COVERAGE_EXHAUSTED" });
    expect(stateAt("2026-10-29T12:00:00+05:30").status).toBe("unknown");
  });
  it("handles leap days and year boundaries", () => {
    const years = parseCalendar({ source: "Synthetic", coverageStart: "2027-12-31", coverageEnd: "2028-03-01", holidays: [], specialSessions: [] });
    expect(getMarketState(years, new Date("2027-12-31T15:30:00+05:30")).nextSession).toMatchObject({ date: "2028-01-03" });
    expect(getMarketDay(years, "2028-02-29").kind).toBe("regular");
    expect(() => getMarketDay(years, "2027-02-29")).toThrow("INVALID_DATE");
  });
  it.each([
    { ...input, coverageStart: "2026-02-30" },
    { ...input, coverageEnd: "2026-01-01" },
    { ...input, coverageEnd: "2040-01-01" },
    { ...input, holidays: [input.holidays[0], input.holidays[0]] },
    { ...input, holidays: [{ date: "2027-01-01", name: "Outside coverage" }] },
    { ...input, specialSessions: [{ date: "2026-11-07", name: "Bad", sessions: [{ open: "25:00", close: "26:00" }] }] },
    { ...input, specialSessions: [{ date: "2026-11-07", name: "Overnight", sessions: [{ open: "19:00", close: "10:00" }] }] },
    { ...input, specialSessions: [{ date: "2026-11-07", name: "Overlap", sessions: [{ open: "10:00", close: "12:00" }, { open: "11:00", close: "13:00" }] }] },
  ])("rejects invalid, conflicting or unbounded calendar definitions", (definition) => {
    expect(() => parseCalendar(definition)).toThrow("INVALID_CALENDAR");
  });
  it("rejects invalid instants and ambiguous CLI timestamps", () => {
    expect(() => marketDate(new Date("invalid"))).toThrow("INVALID_INSTANT");
    expect(() => parseCalendarArgs(["--at", "2026-11-03T09:15:00"])).toThrow("TIMESTAMP_OFFSET_REQUIRED");
    expect(() => parseCalendarArgs(["--at", "2026-02-30T09:15:00Z"])).toThrow("INVALID_INSTANT");
    expect(() => parseCalendarArgs(["--file"])).toThrow("INVALID_ARGUMENTS");
  });
  it("loads local files and reports missing, invalid and oversized inputs safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swing-calendar-"));
    try {
      const path = join(directory, "calendar.json");
      await expect(loadMarketCalendar("")).rejects.toThrow("MARKET_CALENDAR_FILE_REQUIRED");
      await writeFile(path, JSON.stringify(input));
      expect(await loadMarketCalendar(path)).toEqual(calendar);
      await writeFile(path, "invalid JSON");
      await expect(loadMarketCalendar(path)).rejects.toThrow("CALENDAR_UNREADABLE_OR_INVALID_JSON");
      await writeFile(path, "x".repeat(256 * 1024 + 1));
      await expect(loadMarketCalendar(path)).rejects.toThrow("CALENDAR_TOO_LARGE");
    } finally { await rm(directory, { recursive: true }); }
  });
  it("gives identical CLI results under different host timezones", async () => {
    const args = ["--import", "tsx", "scripts/check-market.ts", "--file", "config/market-calendar.example.json", "--at", "2026-11-03T03:45:00Z"];
    const results = await Promise.all(["UTC", "America/Los_Angeles"].map((TZ) => run(process.execPath, args, { env: { ...process.env, TZ }, timeout: 15000 })));
    expect(JSON.parse(results[0].stdout)).toEqual(JSON.parse(results[1].stdout));
    expect(JSON.parse(results[0].stdout)).toMatchObject({ status: "open", localDate: "2026-11-03" });
  });
  it("returns an unsuccessful CLI result when coverage is missing", async () => {
    await expect(run(process.execPath, ["--import", "tsx", "scripts/check-market.ts", "--file", "config/market-calendar.example.json", "--at", "2027-01-01T00:00:00Z"], { timeout: 15000 })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"status":"unknown"') });
  });
});
