import { describe, expect, it, vi } from "vitest";
import { parseCalendar } from "../src/lib/market/calendar";
import { planAnnouncementRun } from "../src/lib/market/scheduler";
import { runAnnouncementPipeline, type PipelineStages } from "../src/lib/jobs/pipeline";
import { ResearchError } from "../src/lib/research/schema";
import { parseEnv } from "../src/lib/config/env";
import { validateJobPayload } from "../src/lib/jobs/handlers";

const calendar = parseCalendar({
  source: "Synthetic test dates only", coverageStart: "2026-11-01", coverageEnd: "2026-11-08",
  holidays: [{ date: "2026-11-04", name: "Synthetic closure" }],
  specialSessions: [{ date: "2026-11-07", name: "Synthetic weekend session", sessions: [{ open: "18:02", close: "18:17" }] }],
});
const plan = (at: string) => planAnnouncementRun(calendar, new Date(at));
function stages() {
  return {
    fetch: vi.fn().mockResolvedValue({ received: 1, inserted: 1, duplicates: 0 }),
    match: vi.fn().mockResolvedValue({ matched: 1, unmatched: 0, ambiguous: 0 }),
    filter: vi.fn().mockResolvedValue({ keep: 1, routine: 0, review: 0 }),
    analyze: vi.fn().mockResolvedValue({ analyzed: 1, skipped: 0, attempted: 1, failed: 0, failures: [] }),
  } satisfies PipelineStages;
}

describe("market-aware announcement scheduling", () => {
  it("assigns stable five-minute session slots anchored to opening", () => {
    expect(plan("2026-11-03T09:15:00+05:30")).toMatchObject({ mode: "session", cadenceMs: 300000, slotStart: "2026-11-03T03:45:00.000Z" });
    expect(plan("2026-11-03T09:19:59.999+05:30").dedupeKey).toBe(plan("2026-11-03T09:15:00+05:30").dedupeKey);
    expect(plan("2026-11-03T09:20:00+05:30").dedupeKey).not.toBe(plan("2026-11-03T09:15:00+05:30").dedupeKey);
  });
  it("switches to IST-hour slots outside sessions, on holidays and weekends", () => {
    expect(plan("2026-11-03T09:14:59+05:30")).toMatchObject({ mode: "off_hours", cadenceMs: 3600000, slotStart: "2026-11-03T03:30:00.000Z" });
    expect(plan("2026-11-03T15:30:00+05:30").mode).toBe("off_hours");
    expect(plan("2026-11-04T12:00:00+05:30").cadenceMs).toBe(3600000);
    expect(plan("2026-11-08T12:00:00+05:30").cadenceMs).toBe(3600000);
    expect(plan("2026-11-03T23:59:59+05:30").dedupeKey).not.toBe(plan("2026-11-04T00:00:00+05:30").dedupeKey);
  });
  it("honors special-session timing and rejects unknown coverage", () => {
    expect(plan("2026-11-07T18:08:00+05:30")).toMatchObject({ mode: "session", slotStart: "2026-11-07T12:37:00.000Z" });
    expect(plan("2026-11-07T18:17:00+05:30").mode).toBe("off_hours");
    expect(() => plan("2027-01-01T09:15:00+05:30")).toThrow("CALENDAR_COVERAGE_REQUIRED");
  });
  it("keeps scheduling and scheduled AI opt-in and validates limits", () => {
    const base = { DATABASE_URL: "postgresql://localhost/swing" };
    expect(parseEnv(base)).toMatchObject({ WORKER_SCHEDULER_ENABLED: false, WORKER_SCHEDULER_AI_ENABLED: false, WORKER_SCHEDULER_AI_LIMIT: 1 });
    expect(() => parseEnv({ ...base, WORKER_SCHEDULER_ENABLED: "yes" })).toThrow("WORKER_SCHEDULER_ENABLED");
    expect(() => parseEnv({ ...base, WORKER_SCHEDULER_AI_LIMIT: "21" })).toThrow("WORKER_SCHEDULER_AI_LIMIT");
    expect(validateJobPayload("announcements.pipeline", {})).toEqual({ analyze: false, analysisLimit: 1 });
    expect(() => validateJobPayload("announcements.pipeline", { analyze: "true" })).toThrow("INVALID_JOB_PAYLOAD");
  });
});

describe("sequential announcement pipeline", () => {
  it("runs stages in order and only calls AI when opted in", async () => {
    const actions = stages();
    await runAnnouncementPipeline(actions, { analyze: false, analysisLimit: 1 }, new AbortController().signal);
    expect(actions.fetch.mock.invocationCallOrder[0]).toBeLessThan(actions.match.mock.invocationCallOrder[0]);
    expect(actions.match.mock.invocationCallOrder[0]).toBeLessThan(actions.filter.mock.invocationCallOrder[0]);
    expect(actions.analyze).not.toHaveBeenCalled();
    await runAnnouncementPipeline(actions, { analyze: true, analysisLimit: 2 }, new AbortController().signal);
    expect(actions.analyze).toHaveBeenCalledWith(2);
  });
  it.each(["fetch", "match", "filter"] as const)("halts downstream stages after %s fails", async (stage) => {
    const actions = stages();
    actions[stage].mockRejectedValue(new Error("secret remote details"));
    await expect(runAnnouncementPipeline(actions, { analyze: true, analysisLimit: 1 }, new AbortController().signal)).rejects.toThrow(`PIPELINE_${stage.toUpperCase()}_FAILED`);
    expect(actions.analyze).not.toHaveBeenCalled();
    if (stage === "fetch") expect(actions.match).not.toHaveBeenCalled();
    if (stage !== "filter") expect(actions.filter).not.toHaveBeenCalled();
  });
  it("fails rather than claiming success when research items fail", async () => {
    const actions = stages();
    actions.analyze.mockResolvedValue({ analyzed: 0, skipped: 0, attempted: 1, failed: 1, failures: [] });
    await expect(runAnnouncementPipeline(actions, { analyze: true, analysisLimit: 1 }, new AbortController().signal)).rejects.toThrow("PIPELINE_ANALYZE_FAILED");
    actions.analyze.mockRejectedValue(new ResearchError("missing_gemini_api_key"));
    await expect(runAnnouncementPipeline(actions, { analyze: true, analysisLimit: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: "AI_CONFIGURATION_REQUIRED", permanent: true });
  });
  it("checks cancellation between stages", async () => {
    const actions = stages();
    const stop = new AbortController();
    actions.fetch.mockImplementation(async () => { stop.abort(); return { received: 0, inserted: 0, duplicates: 0 }; });
    await expect(runAnnouncementPipeline(actions, { analyze: true, analysisLimit: 1 }, stop.signal)).rejects.toThrow("PIPELINE_MATCH_FAILED");
    expect(actions.match).not.toHaveBeenCalled();
  });
});
