import { getDailyAllowance, reserveAiRequest, withDailyAllowance } from "../src/lib/research/allowance";
import { withFallback } from "../src/lib/research/provider";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { filterStoredAnnouncements, RELEVANCE_RULE_VERSION } from "../src/lib/announcements/filter";
import { getInbox, getOverview, getResearchDetail, getReport, inboxFiltersSchema } from "../src/lib/dashboard/queries";
import { storeAnnouncements } from "../src/lib/announcements/ingest";
import { matchStoredAnnouncements } from "../src/lib/announcements/match";
import { seedStarterUniverse } from "../src/lib/instruments/starter-universe";
import { NSE_SOURCE, parseAnnouncements } from "../src/lib/announcements/rss";
import { analyzeStoredAnnouncements } from "../src/lib/research/analyze";
import { ResearchError, type ResearchProvider } from "../src/lib/research/schema";
import { claimJob, enqueueJob, finishJob, JobError, recoverExpiredJobs, renewJobLease } from "../src/lib/jobs/queue";
import { runJobOnce } from "../src/lib/jobs/runner";
import { createJobHandlers } from "../src/lib/jobs/handlers";
import { parseCalendar } from "../src/lib/market/calendar";
import { scheduleAnnouncementRun } from "../src/lib/market/scheduler";
import { createPipelineStages } from "../src/lib/jobs/pipeline";
import { getJobStatus } from "../src/lib/jobs/status";
import { storeMarketSnapshot, importMarketSnapshot } from "../src/lib/market-data/persist";
import { syntheticSnapshot } from "./fixtures/market-snapshot";
import type { MarketDataProvider } from "../src/lib/market-data/provider";
import { detectStoredMovement, MOVEMENT_VERSION } from "../src/lib/market-data/detect";
import { researchMovement } from "../src/lib/research/movement";
import { generateMorningBriefing, scheduleMorningBriefing } from "../src/lib/briefings/morning";
import { RESEARCH_PROMPT_VERSION } from "../src/lib/research/schema";
import { generateClosingBriefing, scheduleClosingBriefing } from "../src/lib/briefings/closing";
import { MOVEMENT_RESEARCH_VERSION } from "../src/lib/research/movement";
import { reassessMorningWatchlist, schedulePostOpen } from "../src/lib/briefings/post-open";

const run = promisify(execFile);
let engine: PGlite;
let server: PGLiteSocketServer;
let db: PrismaClient;
let databaseUrl: string;

async function migrate() {
  // Only the isolated embedded database is migrated; never the user's DATABASE_URL.
  return run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 30000,
  });
}

beforeAll(async () => {
  engine = await PGlite.create();
  server = new PGLiteSocketServer({ db: engine, port: 0, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  databaseUrl = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`;
  await migrate();
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }), log: [] });
}, 40000);

afterAll(async () => {
  await db?.$disconnect();
  await server?.stop();
  await engine?.close();
});
beforeEach(async () => {
  await db.$executeRaw`TRUNCATE research_allowance_uses, universe_imports, daily_briefings, feed_items, instruments, announcements, signals, signal_evidence,
    analyses, alerts, delivery_attempts, jobs, polling_checkpoints, feedback,
    performance_outcomes CASCADE`;
});

function stock(symbol = "EXAMPLE") {
  return db.instrument.create({ data: { exchange: "NSE", symbol, name: symbol } });
}
function movement(instrumentId: string, dedupeKey = "move:example:1") {
  return {
    instrumentId, origin: "movement" as const, dedupeKey, detectorVersion: "v1",
    observedAt: new Date("2026-10-28T04:00:00Z"), windowStart: new Date("2026-10-28T03:59:00Z"),
    price: "102.123456", referencePrice: "100.000000", priceChangePct: "2.12345600",
  };
}
async function signal() {
  const instrument = await stock();
  return db.signal.create({ data: movement(instrument.id) });
}
async function alert() {
  const event = await signal();
  return db.alert.create({ data: {
    signalId: event.id, dedupeKey: "alert:example:1", classification: "WATCH",
    rulesVersion: "v1", reason: "Unverified movement", message: "A factual movement signal", telegramChatId: "-1001234567890",
  } });
}
async function rejectsConstraint(query: PromiseLike<unknown>, constraint: string) {
  try {
    await query;
  } catch (error) {
    // Prisma wraps adapter constraint errors; keep the constraint-name assertion.
    expect(String(error)).toContain(constraint);
    return;
  }
  throw new Error(`Expected database to reject ${constraint}`);
}

describe("Prisma migration and research data", () => {
  it("reads a unified inbox using latest research, parameterized filters, and stable pagination", async () => {
    const tcs = await db.instrument.create({ data: { exchange: "NSE", symbol: "TCS", name: "TCS", inUniverse: true } });
    const item = await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "dashboard", title: "TCS - Results", url: "https://example.com/results", instrumentId: tcs.id, matchStatus: "matched", discoveredAt: new Date("2026-11-03T05:00:00Z") } });
    const research = { feedItemId: item.id, provider: "fixture", model: "fixture", promptVersion: "v1", inputSnapshot: {}, summary: "Older assessment", significance: "Fixture", risks: ["Unverified"], uncertainties: ["Missing context"], evidence: [] };
    await db.feedResearch.create({ data: { ...research, inputHash: "old", classification: "INVESTIGATE", createdAt: new Date("2026-11-03T05:01:00Z") } });
    await db.feedResearch.create({ data: { ...research, inputHash: "new", classification: "IGNORE", summary: "Latest assessment", createdAt: new Date("2026-11-03T05:02:00Z") } });
    const movementRecord = await db.signal.create({ data: { ...movement(tcs.id), dedupeKey: "dashboard-move", createdAt: new Date("2026-11-03T05:03:00Z") } });
    await db.analysis.create({ data: { signalId: movementRecord.id, provider: "fixture", model: "fixture", promptVersion: "v1", summary: "Observed move", assessment: { classification: "WATCH", significance: "Unknown cause" } } });
    const filters = inboxFiltersSchema.parse({});
    const first = await getInbox(db, filters, 1);
    expect(first.total).toBe(2);
    expect(first.items[0]).toMatchObject({ kind: "movement", classification: "WATCH", symbol: "TCS" });
    expect((await getInbox(db, { ...filters, page: 2 }, 1)).items[0]).toMatchObject({ kind: "announcement", classification: "IGNORE", summary: "Latest assessment", eventAt: null });
    expect((await getInbox(db, { ...filters, classification: "INVESTIGATE" })).total).toBe(0);
    expect((await getInbox(db, { ...filters, stock: "TCS", classification: "WATCH" })).total).toBe(1);
    expect((await getInbox(db, { ...filters, stock: "INFY" })).total).toBe(0);
    expect((await getInbox(db, { ...filters, kind: "announcement" })).items).toHaveLength(1);
    const detail = await getResearchDetail(db, "announcement", item.id);
    expect(detail?.research[0].summary).toBe("Latest assessment");
    expect(await db.feedResearch.count()).toBe(2);
    expect(await db.job.count()).toBe(0);
    expect(await db.feedItem.count()).toBe(1);
  });
  it("retains unmatched and unassessed items and returns safe missing-record results", async () => {
    await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "unmatched-dashboard", title: "Unknown - Update", url: "https://example.com/unmatched" } });
    const result = await getInbox(db, inboxFiltersSchema.parse({ classification: "PENDING" }));
    expect(result.items[0]).toMatchObject({ symbol: null, classification: "PENDING", summary: null });
    expect(await getResearchDetail(db, "announcement", "invalid-id")).toBeNull();
    expect(await getResearchDetail(db, "unsupported", "2db4cdf2-9478-4929-b0c9-a76f6c0eed27")).toBeNull();
    expect(await getReport(db, "invalid-id")).toBeNull();
    const before = await db.feedItem.findFirstOrThrow();
    const overview = await getOverview(db);
    expect(overview.announcements).toBe(1);
    expect(overview.lastQuote).toBeNull();
    expect(overview.queue.lastPipelineCompletedAt).toBeNull();
    expect(await db.feedItem.findFirstOrThrow()).toEqual(before);
  });
  const reassessmentCalendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-02", coverageEnd: "2026-11-04", holidays: [], specialSessions: [] });
  async function reassessmentMorning() {
    await seedStarterUniverse(db);
    const feed = await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "reassessment-fixture", title: "TCS - Results", url: "https://example.com/reassess" } });
    return db.dailyBriefing.create({ data: { kind: "morning", sessionDate: new Date("2026-11-03"), reportVersion: "morning-v1", windowStart: new Date("2026-11-02T10:00:00Z"), cutoffAt: new Date("2026-11-03T03:15:00Z"), generatedAt: new Date("2026-11-03T03:16:00Z"), content: { watchlist: [{ symbol: "TCS", feedItemId: feed.id }, { symbol: "TCS", feedItemId: feed.id }] }, markdown: "Synthetic premarket watchlist" } });
  }
  async function postOpenQuote(price: string, quoteTime: string, retrievedAt: string) {
    const snapshot = syntheticSnapshot(); snapshot.retrievedAt = retrievedAt;
    snapshot.quote!.retrievedAt = retrievedAt; snapshot.quote!.marketTime = quoteTime; snapshot.quote!.price = price;
    snapshot.quote!.ageSeconds = (Date.parse(retrievedAt) - Date.parse(quoteTime)) / 1000;
    const result = await storeMarketSnapshot(db, snapshot);
    // Synthetic as-of fixture; actual imports use their real recordedAt.
    await db.marketSnapshotRecord.update({ where: { id: result.snapshotId }, data: { recordedAt: new Date(retrievedAt) } });
    return result;
  }
  it("persists pending-to-caution/watch revisions and skips unchanged reassessments", async () => {
    await reassessmentMorning();
    const at = new Date("2026-11-03T03:50:10Z");
    expect(await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", at)).toMatchObject({ pending: 1, inserted: 1 });
    await postOpenQuote("100", "2026-11-03T03:45:20Z", "2026-11-03T03:45:30Z");
    await postOpenQuote("105", "2026-11-03T03:50:00Z", "2026-11-03T03:50:05Z");
    const ready = await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", at);
    expect(ready).toMatchObject({ caution: 1, inserted: 1, assessments: [{ status: "CAUTION", reason: "RAPID_POST_OPEN_RISE", content: { overnightGapPct: null, action: "research_only", changeSinceObservedOpenPct: "5.00000000" } }] });
    expect(await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T03:50:15Z"))).toMatchObject({ inserted: 0, caution: 1 });
    expect(await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T03:53:00Z"))).toMatchObject({ pending: 1, inserted: 1 });
    await postOpenQuote("101", "2026-11-03T03:53:00Z", "2026-11-03T03:53:05Z");
    expect(await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T03:53:10Z"))).toMatchObject({ watch: 1, inserted: 1 });
    expect(await db.postOpenAssessment.count()).toBe(4);
    expect(await db.analysis.count()).toBe(0);
  });
  it("does not reuse an earlier quote when the latest known retrieval is missing data", async () => {
    await reassessmentMorning();
    await postOpenQuote("100", "2026-11-03T03:45:20Z", "2026-11-03T03:45:30Z");
    await postOpenQuote("101", "2026-11-03T03:50:00Z", "2026-11-03T03:50:05Z");
    const missing = syntheticSnapshot(); missing.quote = null; missing.retrievedAt = "2026-11-03T03:51:00.000Z";
    const row = await storeMarketSnapshot(db, missing);
    await db.marketSnapshotRecord.update({ where: { id: row.snapshotId }, data: { recordedAt: new Date(missing.retrievedAt) } });
    expect(await reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T03:51:10Z"))).toMatchObject({ pending: 1, assessments: [{ reason: "CURRENT_QUOTE_MISSING" }] });
  });
  it("requires a genuinely premarket report and rejects early/late evaluation", async () => {
    const at = new Date("2026-11-03T03:50:00Z");
    await expect(reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", at)).rejects.toThrow("MORNING_BRIEFING_REQUIRED");
    const morning = await reassessmentMorning();
    await db.dailyBriefing.update({ where: { id: morning.id }, data: { generatedAt: new Date("2026-11-03T03:46:00Z") } });
    await expect(reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", at)).rejects.toThrow("MORNING_REPORT_NOT_PREMARKET");
    await db.dailyBriefing.update({ where: { id: morning.id }, data: { generatedAt: new Date("2026-11-03T03:45:00Z") } });
    await expect(reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", at)).rejects.toThrow("MORNING_REPORT_NOT_PREMARKET");
    await expect(reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T03:49:59Z"))).rejects.toThrow("BRIEFING_NOT_DUE");
    await expect(reassessMorningWatchlist(db, reassessmentCalendar, "2026-11-03", new Date("2026-11-03T04:00:00Z"))).rejects.toThrow("REASSESSMENT_WINDOW_CLOSED");
    expect(await db.postOpenAssessment.count()).toBe(0);
  });
  it("deduplicates scheduler replicas per minute and allows later retry slots for pending data", async () => {
    const at = new Date("2026-11-03T03:50:00Z");
    const results = await Promise.all([schedulePostOpen(db, reassessmentCalendar, at), schedulePostOpen(db, reassessmentCalendar, at)]);
    expect(results.map((entry) => entry.status).sort()).toEqual(["already_scheduled", "enqueued"]);
    expect((await schedulePostOpen(db, reassessmentCalendar, new Date("2026-11-03T03:51:00Z"))).status).toBe("enqueued");
    expect((await schedulePostOpen(db, reassessmentCalendar, new Date("2026-11-03T04:00:00Z"))).status).toBe("skipped");
    expect(await db.job.count({ where: { kind: "briefings.reassess" } })).toBe(2);
  });
  const closingCalendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-02", coverageEnd: "2026-11-04", holidays: [], specialSessions: [] });
  async function closingItems() {
    await seedStarterUniverse(db);
    const snapshot = syntheticSnapshot(); snapshot.retrievedAt = "2026-11-03T10:00:00.000Z";
    snapshot.quote!.retrievedAt = snapshot.retrievedAt; snapshot.quote!.marketTime = "2026-11-03T09:59:00.000Z";
    snapshot.candles[0].sessionDate = "2026-11-03"; snapshot.candles[0].timestamp = "2026-11-03T03:45:00.000Z"; snapshot.candles[0].volume = "12345";
    const stored = await storeMarketSnapshot(db, snapshot);
    // Backdate recording only to simulate an observation known before test cutoff.
    await db.marketSnapshotRecord.update({ where: { id: stored.snapshotId }, data: { recordedAt: new Date(snapshot.retrievedAt) } });
    const instrument = await db.instrument.findUniqueOrThrow({ where: { exchange_symbol: { exchange: "NSE", symbol: "TCS" } } });
    await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "closing-filing", title: "TCS - Results", url: "https://example.com/closing", instrumentId: instrument.id,
      publishedAt: new Date("2026-11-03T09:00:00Z"), discoveredAt: new Date("2026-11-03T09:01:00Z"), matchStatus: "matched", matchCheckedAt: new Date("2026-11-03T09:02:00Z"),
      relevanceStatus: "keep", relevanceReason: "POTENTIALLY_MATERIAL_CONTEXT", relevanceRuleVersion: RELEVANCE_RULE_VERSION, relevanceCheckedAt: new Date("2026-11-03T09:03:00Z") } });
    const signal = await db.signal.create({ data: { instrumentId: instrument.id, origin: "movement", dedupeKey: "closing-trigger", detectorVersion: MOVEMENT_VERSION,
      observedAt: new Date("2026-11-03T09:50:00Z"), windowStart: new Date("2026-11-03T09:45:00Z"), price: "103", referencePrice: "100", priceChangePct: "3", createdAt: new Date("2026-11-03T09:51:00Z") } });
    await db.analysis.createMany({ data: [
      { signalId: signal.id, provider: "test", model: "test", promptVersion: MOVEMENT_RESEARCH_VERSION, summary: "Known before cutoff", createdAt: new Date("2026-11-03T09:52:00Z") },
      { signalId: signal.id, provider: "test", model: "test", promptVersion: MOVEMENT_RESEARCH_VERSION, summary: "FUTURE RESEARCH", createdAt: new Date("2026-11-03T10:16:00Z") },
    ] });
    const later = structuredClone(snapshot); later.retrievedAt = "2026-11-03T10:16:00.000Z";
    later.quote!.retrievedAt = later.retrievedAt; later.quote!.ageSeconds = 1020; later.quote!.freshness = "stale"; later.quote!.price = "999";
    await storeMarketSnapshot(db, later);
    return snapshot;
  }
  it("stores a preliminary closing report without leaking later observations or research", async () => {
    const snapshot = await closingItems(); const at = new Date("2026-11-03T10:15:00Z");
    const results = await Promise.all([generateClosingBriefing(db, closingCalendar, "2026-11-03", at), generateClosingBriefing(db, closingCalendar, "2026-11-03", at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["existing", "generated"]);
    const report = results[0].report;
    expect(report.content).toMatchObject({ status: "preliminary", coverage: { universeCount: 6, suitableCloseObservations: 1, indices: "unavailable", dailyReturnRankings: "unavailable", unusualVolume: "not_computed" },
      movements: [{ priceChangePct: "3", methodology: "recorded 5–6 minute trigger, not a daily return", research: { summary: "Known before cutoff", catalystVerified: false } }] });
    expect(report.markdown).toContain(snapshot.quote!.price);
    expect(report.markdown).not.toContain("FUTURE RESEARCH");
    expect(report.markdown).not.toContain("₹999");
    expect(report.markdown).toContain("PRELIMINARY");
    expect(await db.dailyBriefing.count()).toBe(1);
    expect((await generateClosingBriefing(db, closingCalendar, "2026-11-03", new Date("2026-11-03T11:00:00Z"))).report.id).toBe(report.id);
    await generateMorningBriefing(db, closingCalendar, "2026-11-03", at);
    expect(await db.dailyBriefing.count()).toBe(2);
  });
  it("does not substitute an older quote when the latest known retrieval has none", async () => {
    const snapshot = await closingItems(); const missing = { ...snapshot, retrievedAt: "2026-11-03T10:10:00.000Z", quote: null };
    const stored = await storeMarketSnapshot(db, missing);
    await db.marketSnapshotRecord.update({ where: { id: stored.snapshotId }, data: { recordedAt: new Date(missing.retrievedAt) } });
    const result = await generateClosingBriefing(db, closingCalendar, "2026-11-03", new Date("2026-11-03T10:15:00Z"));
    expect(result.report.content).toMatchObject({ coverage: { suitableCloseObservations: 0 } });
    expect(result.report.markdown).not.toContain(`₹${snapshot.quote!.price}`);
  });
  it("queues a closing report once, including while ingestion is busy, and refuses premature generation", async () => {
    await enqueueJob(db, { kind: "announcements.pipeline", dedupeKey: "closing-busy" });
    const at = new Date("2026-11-03T10:15:00Z");
    const results = await Promise.all([scheduleClosingBriefing(db, closingCalendar, at), scheduleClosingBriefing(db, closingCalendar, at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_scheduled", "enqueued"]);
    expect(await db.job.count({ where: { kind: "briefings.closing" } })).toBe(1);
    await expect(generateClosingBriefing(db, closingCalendar, "2026-11-03", new Date("2026-11-03T10:14:59Z"))).rejects.toThrow("BRIEFING_NOT_DUE");
    expect(await db.dailyBriefing.count()).toBe(0);
  });
  const briefingCalendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-02", coverageEnd: "2026-11-08", holidays: [], specialSessions: [] });
  async function briefingItems() {
    await seedStarterUniverse(db);
    const instrument = await db.instrument.findUniqueOrThrow({ where: { exchange_symbol: { exchange: "NSE", symbol: "TCS" } } });
    const common = { source: NSE_SOURCE, instrumentId: instrument.id, matchStatus: "matched" as const, matchCheckedAt: new Date("2026-11-03T03:01:00Z"),
      relevanceStatus: "keep" as const, relevanceReason: "POTENTIALLY_MATERIAL_CONTEXT", relevanceRuleVersion: RELEVANCE_RULE_VERSION, relevanceCheckedAt: new Date("2026-11-03T03:02:00Z"),
      discoveredAt: new Date("2026-11-03T03:00:00Z"), publishedAt: new Date("2026-11-02T15:00:00Z") };
    await db.feedItem.createMany({ data: [
      { ...common, sourceId: "overnight", title: "TCS - Results", url: "https://example.com/results" },
      { ...common, sourceId: "found-later", title: "TCS - Acquisition", url: "https://example.com/late", discoveredAt: new Date("2026-11-03T03:16:00Z") },
      { ...common, sourceId: "future-publication", title: "TCS - Results", url: "https://example.com/future", publishedAt: new Date("2026-11-03T03:16:00Z") },
      { ...common, sourceId: "processed-later", title: "TCS - Results", url: "https://example.com/processed", relevanceCheckedAt: new Date("2026-11-03T03:16:00Z") },
      { ...common, sourceId: "undated", title: "TCS - Update", url: "https://example.com/undated", publishedAt: null },
      { ...common, sourceId: "routine", title: "TCS - Trading Window Closure", url: "https://example.com/routine", relevanceStatus: "routine" },
    ] });
    const feed = await db.feedItem.findUniqueOrThrow({ where: { source_sourceId: { source: NSE_SOURCE, sourceId: "overnight" } } });
    await db.feedResearch.createMany({ data: [
      { feedItemId: feed.id, provider: "test", model: "test", promptVersion: RESEARCH_PROMPT_VERSION, inputHash: "before", inputSnapshot: {}, classification: "WATCH", summary: "Stored pre-cutoff research.", significance: "Review filing.", risks: [], uncertainties: [], evidence: [], createdAt: new Date("2026-11-03T03:10:00Z") },
      { feedItemId: feed.id, provider: "test", model: "test", promptVersion: RESEARCH_PROMPT_VERSION, inputHash: "after", inputSnapshot: {}, classification: "INVESTIGATE", summary: "LATER INFORMATION MUST NOT APPEAR", significance: "Later", risks: [], uncertainties: [], evidence: [], createdAt: new Date("2026-11-03T03:16:00Z") },
    ] });
  }
  it("builds an immutable morning report with no future filings or research leaking past cutoff", async () => {
    await briefingItems();
    const at = new Date("2026-11-03T03:16:00Z");
    const results = await Promise.all([generateMorningBriefing(db, briefingCalendar, "2026-11-03", at), generateMorningBriefing(db, briefingCalendar, "2026-11-03", at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["existing", "generated"]);
    expect(results[0].report.id).toBe(results[1].report.id);
    const report = results[0].report;
    expect(report.content).toMatchObject({ totalEligibleFilings: 1, undatedFilingsExcluded: 1, windowBasis: "previous_session_close", generatedAfterOpen: false,
      coverage: { collectionStatus: "unverified", universeCount: 6 }, watchlist: [{ symbol: "TCS", classification: "WATCH" }] });
    expect(report.markdown).toContain("Stored pre-cutoff research");
    expect(report.markdown).not.toContain("LATER INFORMATION");
    expect(await db.dailyBriefing.count()).toBe(1);
    const later = await generateMorningBriefing(db, briefingCalendar, "2026-11-03", new Date("2026-11-03T10:00:00Z"));
    expect(later.report.generatedAt).toEqual(report.generatedAt);
    expect(later.report.markdown).toBe(report.markdown);
    expect(await db.feedResearch.count()).toBe(2);
  });
  it("reports missing sources and late generation honestly without an AI call", async () => {
    const result = await generateMorningBriefing(db, briefingCalendar, "2026-11-03", new Date("2026-11-03T10:00:00Z"));
    expect(result.report.content).toMatchObject({ generatedAfterOpen: true, totalEligibleFilings: 0, coverage: { collectionStatus: "unverified", globalMarkets: "not_configured", earningsCalendar: "not_configured" } });
    expect(result.report.markdown).toContain("does not establish that no market developments occurred");
    expect(await db.analysis.count()).toBe(0);
    expect(await db.feedResearch.count()).toBe(0);
    await expect(generateMorningBriefing(db, briefingCalendar, "2026-11-04", new Date("2026-11-04T03:14:00Z"))).rejects.toThrow("BRIEFING_NOT_DUE");
  });
  it("schedules one briefing independently of an active announcement pipeline", async () => {
    await enqueueJob(db, { kind: "announcements.pipeline", dedupeKey: "busy-pipeline" });
    const at = new Date("2026-11-03T03:15:00Z");
    const results = await Promise.all([scheduleMorningBriefing(db, briefingCalendar, at), scheduleMorningBriefing(db, briefingCalendar, at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_scheduled", "enqueued"]);
    expect(await db.job.count({ where: { kind: "briefings.morning" } })).toBe(1);
    expect((await scheduleMorningBriefing(db, briefingCalendar, new Date("2026-11-03T03:16:00Z"))).status).toBe("already_scheduled");
    expect(await scheduleMorningBriefing(db, briefingCalendar, new Date("2026-11-03T03:45:00Z"))).toMatchObject({ reason: "PREMARKET_WINDOW_CLOSED" });
  });
  async function linkedMovement() {
    await movementQuotes();
    const result = await detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", new Date("2026-11-03T04:30:00Z"));
    if (!("signalId" in result)) throw new Error("Expected movement fixture");
    return result.signalId;
  }
  async function evidenceRows() {
    await db.feedItem.createMany({ data: [
      ["before", "TCS - Results", "2026-11-03T04:20:00Z", "2026-11-03T04:21:00Z"],
      ["after", "TCS - Acquisition", "2026-11-03T04:40:00Z", "2026-11-03T04:41:00Z"],
      ["late", "TCS - Results", "2026-11-03T05:01:00Z", "2026-11-03T05:02:00Z"],
      ["old", "TCS - Results", "2026-11-02T04:29:00Z", "2026-11-02T04:29:00Z"],
      ["unknown-date", "TCS - Update", null, "2026-11-03T04:20:00Z"],
      ["routine", "TCS - Trading Window Closure", "2026-11-03T04:20:00Z", "2026-11-03T04:21:00Z"],
      ["other-stock", "INFY - Results", "2026-11-03T04:20:00Z", "2026-11-03T04:21:00Z"],
      ["not-yet-found", "TCS - Results", "2026-11-03T04:20:00Z", "2026-11-03T06:00:00Z"],
    ].map(([sourceId, title, publishedAt, discoveredAt]) => ({ source: NSE_SOURCE, sourceId: sourceId!, title: title!, url: `https://example.com/${sourceId}`, publishedAt: publishedAt ? new Date(publishedAt) : null, discoveredAt: new Date(discoveredAt!) })) });
    await matchStoredAnnouncements(db); await filterStoredAnnouncements(db);
  }
  function movementProvider() {
    return { name: "test", model: "movement-test", analyze: vi.fn<ResearchProvider["analyze"]>().mockImplementation(async (input) => {
      if (!("movement" in input)) throw new Error("Expected movement context");
      return { assessment: { classification: "INVESTIGATE", summary: "Observed price movement; catalyst not established.", significance: "Investigate the provided evidence.",
        risks: ["Unverified source timing and price data."], uncertainties: ["A nearby disclosure does not establish cause."], evidenceIds: input.evidence.map((entry) => entry.id) }, inputTokens: 120, outputTokens: 80 };
    }) } satisfies ResearchProvider;
  }
  it("links only same-stock, timed, relevant announcements and deduplicates evidence", async () => {
    const id = await linkedMovement(); await evidenceRows();
    const at = new Date("2026-11-03T05:00:00Z");
    expect(await researchMovement(db, id, undefined, at)).toMatchObject({ status: "linked", evidenceCount: 2, evidenceInserted: 2, catalystVerified: false });
    const links = await db.signalEvidence.findMany({ orderBy: { url: "asc" } });
    expect(links.map((entry) => entry.url)).toEqual(["https://example.com/after", "https://example.com/before"]);
    expect(await researchMovement(db, id, undefined, at)).toMatchObject({ evidenceInserted: 0 });
    expect(await db.analysis.count()).toBe(0);
  });
  it("persists movement research with timing labels, source IDs and no verified catalyst", async () => {
    const id = await linkedMovement(); await evidenceRows(); const provider = movementProvider();
    expect(await researchMovement(db, id, provider, new Date("2026-11-03T05:00:00Z"))).toMatchObject({ status: "analyzed", evidenceCount: 2, catalystVerified: false });
    expect(await researchMovement(db, id, provider, new Date("2026-11-03T05:01:00Z"))).toMatchObject({ status: "duplicate" });
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    const input = provider.analyze.mock.calls[0][0];
    if (!("movement" in input)) throw new Error("Expected movement input");
    expect(input.movement).toMatchObject({ signalId: id, source: "yahoo-experimental", delayStatus: "unknown" });
    expect(input.evidence.map((entry) => entry.timing)).toContain("published_after_move");
    expect(input.evidence.find((entry) => entry.url === "https://example.com/before")?.knownAtMove).toBe(true);
    expect(input.evidence.find((entry) => entry.url === "https://example.com/after")?.knownAtMove).toBe(false);
    const stored = await db.analysis.findFirstOrThrow();
    expect(stored).toMatchObject({ signalId: id, catalyst: null, catalystVerified: false, inputHash: expect.any(String), assessment: { classification: "INVESTIGATE" } });
  });
  it("supports an unknown catalyst without inventing announcement citations and updates when evidence arrives", async () => {
    const id = await linkedMovement(); const provider = movementProvider();
    expect(await researchMovement(db, id, provider, new Date("2026-11-03T04:31:00Z"))).toMatchObject({ evidenceCount: 0 });
    const first = provider.analyze.mock.calls[0][0];
    expect("evidence" in first && first.evidence.map((entry) => entry.id)).toEqual(["movement"]);
    await evidenceRows();
    expect(await researchMovement(db, id, provider, new Date("2026-11-03T05:00:00Z"))).toMatchObject({ status: "analyzed", evidenceCount: 2 });
    expect(await db.analysis.count()).toBe(2);
    expect(await db.signalEvidence.count()).toBe(2);
  });
  it("rejects fabricated evidence IDs and source mismatch without saving model output", async () => {
    const id = await linkedMovement(); const provider = movementProvider();
    provider.analyze.mockResolvedValue({ assessment: { classification: "WATCH", summary: "Test", significance: "Test", risks: ["Unknown"], uncertainties: ["Unknown"], evidenceIds: ["fabricated"] }, inputTokens: 1, outputTokens: 1 });
    await expect(researchMovement(db, id, provider, new Date("2026-11-03T05:00:00Z"))).rejects.toThrow("invalid_movement_research");
    expect(await db.analysis.count()).toBe(0);
    await db.signal.update({ where: { id }, data: { context: {} } });
    await expect(researchMovement(db, id, undefined, new Date("2026-11-03T05:00:00Z"))).rejects.toThrow("movement_sources_missing");
  });
  it("runs the automatically queued movement linker without an AI call", async () => {
    const id = await linkedMovement();
    expect(await runJobOnce(db, "movement-worker", createJobHandlers(db))).toMatchObject({ status: "succeeded", kind: "movements.research" });
    expect((await db.job.findFirstOrThrow()).signalId).toBe(id);
    expect(await db.analysis.count()).toBe(0);
  });
  const movementCalendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-03", coverageEnd: "2026-11-03", holidays: [], specialSessions: [] });
  async function movementQuotes() {
    await seedStarterUniverse(db);
    const reference = syntheticSnapshot();
    reference.retrievedAt = "2026-11-03T04:25:00.000Z";
    reference.quote!.retrievedAt = reference.retrievedAt; reference.quote!.marketTime = reference.retrievedAt;
    reference.quote!.ageSeconds = 0; reference.quote!.price = "100";
    await storeMarketSnapshot(db, reference);
    const current = syntheticSnapshot();
    current.quote!.marketTime = current.retrievedAt; current.quote!.ageSeconds = 0; current.quote!.price = "103.123456789012345678";
    await storeMarketSnapshot(db, current);
    return current;
  }
  it("stores exact movement prices and deduplicates repeated/concurrent detections", async () => {
    const current = await movementQuotes();
    const at = new Date("2026-11-03T04:30:00Z");
    const results = await Promise.all([detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", at), detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "inserted"]);
    expect(await db.signal.count()).toBe(1);
    const signal = await db.signal.findFirstOrThrow();
    expect(signal).toMatchObject({ origin: "movement", detectorVersion: MOVEMENT_VERSION, context: { provider: "yahoo-experimental", direction: "up", delayStatus: "unknown" } });
    expect(signal.price?.toFixed(18)).toBe(current.quote!.price);
    expect(signal.referencePrice?.toString()).toBe("100");
    expect(signal.priceChangePct?.toFixed(8)).toBe("3.12345679");
    expect(await db.job.count()).toBe(1);
    expect(await db.job.findFirstOrThrow()).toMatchObject({ kind: "movements.research", signalId: signal.id, payload: { signalId: signal.id, analyze: false } });
    const repeated = { ...current, retrievedAt: "2026-11-03T04:31:00.000Z", quote: { ...current.quote!, retrievedAt: "2026-11-03T04:31:00.000Z", ageSeconds: 60 } };
    await storeMarketSnapshot(db, repeated);
    expect(await detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", new Date(repeated.retrievedAt))).toMatchObject({ status: "duplicate" });
    expect(await db.signal.count()).toBe(1);
  });
  it("does not fall back from a missing latest quote and refuses stale saved data", async () => {
    const current = await movementQuotes();
    expect(await detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", new Date("2026-11-03T04:36:00Z"))).toMatchObject({ reason: "STALE_CURRENT_QUOTE" });
    await storeMarketSnapshot(db, { ...current, retrievedAt: "2026-11-03T04:31:00.000Z", quote: null });
    expect(await detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", new Date("2026-11-03T04:31:00Z"))).toMatchObject({ reason: "NO_CURRENT_QUOTE" });
    expect(await db.signal.count()).toBe(0);
  });
  it("does not invent a baseline when only one quote is stored", async () => {
    await seedStarterUniverse(db);
    await storeMarketSnapshot(db, syntheticSnapshot());
    expect(await detectStoredMovement(db, movementCalendar, { exchange: "NSE", symbol: "TCS" }, "yahoo-experimental", new Date("2026-11-03T04:30:00Z"))).toMatchObject({ reason: "NO_REFERENCE_QUOTE" });
    expect(await db.signal.count()).toBe(0);
  });
  it("stores precise quotes/candles once under concurrent repeat imports", async () => {
    await seedStarterUniverse(db);
    const snapshot = syntheticSnapshot();
    const results = await Promise.all([storeMarketSnapshot(db, snapshot), storeMarketSnapshot(db, snapshot)]);
    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(results[0].snapshotId).toBe(results[1].snapshotId);
    expect(await db.marketSnapshotRecord.count()).toBe(1);
    expect(await db.marketCandleRecord.count()).toBe(1);
    const stored = await db.marketSnapshotRecord.findFirstOrThrow({ include: { candles: true } });
    expect(stored.quotePrice?.toFixed(18)).toBe(snapshot.quote!.price);
    expect(stored.quoteAgeSeconds?.toNumber()).toBe(60);
    expect(stored).toMatchObject({ quoteFreshness: "recent", quoteDelayStatus: "unknown", currency: "INR" });
    expect(stored.candles[0]).toMatchObject({ volume: null, adjustedClose: null, completion: "unknown", priceBasis: "provider_native_unverified" });
    const repeated = await storeMarketSnapshot(db, snapshot);
    expect(repeated).toMatchObject({ inserted: false, candlesInserted: 0 });
    expect((await db.marketSnapshotRecord.findFirstOrThrow()).recordedAt).toEqual(stored.recordedAt);
  });
  it("preserves revised candles and orders observations by retrieval rather than import time", async () => {
    await seedStarterUniverse(db);
    const earlier = syntheticSnapshot(), later = syntheticSnapshot();
    later.retrievedAt = "2026-11-03T04:40:00.000Z";
    later.quote!.retrievedAt = later.retrievedAt; later.quote!.ageSeconds = 660; later.quote!.freshness = "stale";
    later.candles[0].close = "101";
    const newest = await storeMarketSnapshot(db, later);
    await storeMarketSnapshot(db, earlier);
    expect(await db.marketCandleRecord.count()).toBe(2);
    const latest = await db.marketSnapshotRecord.findFirstOrThrow({ orderBy: { retrievedAt: "desc" }, include: { candles: true } });
    expect(latest.id).toBe(newest.snapshotId);
    expect(latest.quoteFreshness).toBe("stale");
    expect(latest.candles[0].close.toString()).toBe("101");
    expect(await db.marketSnapshotRecord.count()).toBe(2);
  });
  it("stores missing quotes explicitly and rejects invalid imports without partial records", async () => {
    await seedStarterUniverse(db);
    const bad = syntheticSnapshot(); bad.candles[0].close = "100.1234567890123456789";
    await expect(storeMarketSnapshot(db, bad)).rejects.toThrow("PRICE_PRECISION_UNSUPPORTED");
    expect(await db.marketSnapshotRecord.count()).toBe(0);
    expect(await db.marketCandleRecord.count()).toBe(0);
    const historyOnly = syntheticSnapshot(); historyOnly.quote = null;
    expect(await storeMarketSnapshot(db, historyOnly)).toMatchObject({ inserted: true, quoteStored: false });
    expect(await db.marketSnapshotRecord.findFirstOrThrow()).toMatchObject({ quotePrice: null, quoteTime: null, quoteAgeSeconds: null, quoteFreshness: null, quoteDelayStatus: null });
  });
  it("requires an active configured stock before fetching and verifies returned provider identity", async () => {
    const provider = { name: "yahoo-experimental", getSnapshot: vi.fn<MarketDataProvider["getSnapshot"]>().mockResolvedValue(syntheticSnapshot()) };
    await expect(importMarketSnapshot(db, provider, { exchange: "NSE", symbol: "TCS" })).rejects.toThrow("INSTRUMENT_NOT_IN_UNIVERSE");
    expect(provider.getSnapshot).not.toHaveBeenCalled();
    await seedStarterUniverse(db);
    const wrong = syntheticSnapshot(); wrong.instrument.symbol = "INFY";
    provider.getSnapshot.mockResolvedValueOnce(wrong);
    await expect(importMarketSnapshot(db, provider, { exchange: "NSE", symbol: "TCS" })).rejects.toThrow("PROVIDER_SNAPSHOT_MISMATCH");
    expect(await db.marketSnapshotRecord.count()).toBe(0);
    expect(await importMarketSnapshot(db, provider, { exchange: "NSE", symbol: " tcs " })).toMatchObject({ inserted: true, candlesInserted: 1 });
  });
  it("enforces complete quote metadata and valid candle prices in SQL", async () => {
    await seedStarterUniverse(db);
    const result = await storeMarketSnapshot(db, syntheticSnapshot());
    await expect(db.marketSnapshotRecord.update({ where: { id: result.snapshotId }, data: { quoteFreshness: "stale" } })).rejects.toThrow();
    const candle = await db.marketCandleRecord.findFirstOrThrow();
    await expect(db.marketCandleRecord.update({ where: { id: candle.id }, data: { low: "200" } })).rejects.toThrow();
    expect((await db.marketCandleRecord.findFirstOrThrow()).low.toString()).toBe("98");
  });
  it("reports queue failures, due work and expired leases without sensitive fields or mutations", async () => {
    await db.job.createMany({ data: [
      { kind: "secret-kind", dedupeKey: "secret-key", payload: { credential: "secret-value" }, status: "failed", completedAt: new Date(), lastErrorCode: "secret-error" },
      { kind: "database.check", dedupeKey: "retry-status", status: "retry", attempts: 1, runAfter: new Date(0), lastErrorCode: "HANDLER_FAILED" },
      { kind: "database.check", dedupeKey: "expired-status", status: "running", attempts: 1, lockedBy: "secret-lease", lockedUntil: new Date(0) },
      { kind: "database.check", dedupeKey: "future-status", runAfter: new Date("2099-01-01") },
    ] });
    await db.pollingCheckpoint.create({ data: { source: "swing-scheduler", scope: "announcements-v1", cursor: { secret: "secret-cursor" }, lastSuccessAt: new Date() } });
    const result = await getJobStatus(db);
    expect(result).toMatchObject({ counts: { pending: 1, retry: 1, running: 1, failed: 1, succeeded: 0 }, dueJobs: 1, expiredLeases: 1, hasFailedJobs: true, recentFailures: [{ kind: "unsupported", lastErrorCode: "UNKNOWN_ERROR" }] });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await db.job.count()).toBe(4);
    expect((await db.job.findUniqueOrThrow({ where: { dedupeKey: "expired-status" } })).status).toBe("running");
  });
  it("emits recovery and claim events without letting telemetry failures strand work", async () => {
    const job = await enqueueJob(db, { kind: "database.check", dedupeKey: "observe-recovery" });
    await claimJob(db, "dead-worker");
    await db.job.update({ where: { id: job.id }, data: { lockedUntil: new Date(0) } });
    const recovered = vi.fn();
    expect(await runJobOnce(db, "new-worker", createJobHandlers(db), undefined, { onRecovery: recovered })).toEqual({ status: "idle" });
    expect(recovered).toHaveBeenCalledWith(1);
    await db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
    const claimed = vi.fn(() => { throw new Error("Telemetry failure"); });
    expect(await runJobOnce(db, "new-worker", createJobHandlers(db), undefined, { onClaim: claimed })).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(claimed).toHaveBeenCalledWith({ jobId: job.id, kind: "database.check", attempt: 2 });
  });
  const schedulerCalendar = parseCalendar({ source: "Synthetic", coverageStart: "2026-11-01", coverageEnd: "2026-11-08", holidays: [], specialSessions: [] });
  const schedulerOptions = { analyze: false, analysisLimit: 1 };
  it("deduplicates concurrent scheduler ticks and retains the slot across restarts", async () => {
    const at = new Date("2026-11-02T09:15:00+05:30");
    const results = await Promise.all([scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, at), scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, at)]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_scheduled", "enqueued"]);
    expect(await db.job.count()).toBe(1);
    expect((await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:19:00+05:30"))).status).toBe("already_scheduled");
    expect(await db.pollingCheckpoint.findFirstOrThrow()).toMatchObject({ source: "swing-scheduler", scope: "announcements-v1", cursor: { slotStart: "2026-11-02T03:45:00.000Z", mode: "session" } });
  });
  it("does not accumulate pipelines while earlier work is active or retrying", async () => {
    const first = await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:15:00+05:30"));
    expect((await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:20:00+05:30"))).status).toBe("busy");
    await db.job.update({ where: { id: first.jobId }, data: { status: "retry" } });
    expect((await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:25:00+05:30"))).status).toBe("busy");
    await db.job.update({ where: { id: first.jobId }, data: { status: "failed", completedAt: new Date() } });
    expect((await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:25:00+05:30"))).status).toBe("enqueued");
    expect(await db.job.count()).toBe(2);
    await expect(scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2027-01-01"))).rejects.toThrow("CALENDAR_COVERAGE_REQUIRED");
    expect(await db.job.count()).toBe(2);
  });
  it("executes a scheduled pipeline through storage, matching and filtering, then retries safely", async () => {
    await seedStarterUniverse(db);
    const result = await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:15:00+05:30"));
    const stages = createPipelineStages(db);
    const item = { sourceId: "pipeline-fixture", title: "TCS - Results", description: "Synthetic results fixture", url: "https://example.com/pipeline", publishedAt: null };
    // Explicit synthetic input for a database pipeline test, never a live fallback.
    stages.fetch = () => storeAnnouncements(db, [item]);
    expect(await runJobOnce(db, "pipeline-worker", createJobHandlers(db, stages))).toMatchObject({ status: "succeeded", jobId: result.jobId });
    expect(await db.feedItem.findFirstOrThrow()).toMatchObject({ matchStatus: "matched", relevanceStatus: "keep" });
    expect(await db.feedResearch.count()).toBe(0);
    const next = await scheduleAnnouncementRun(db, schedulerCalendar, schedulerOptions, new Date("2026-11-02T09:20:00+05:30"));
    const failing = { ...stages, filter: async () => { throw new Error("private remote details"); } };
    expect(await runJobOnce(db, "pipeline-worker", createJobHandlers(db, failing))).toMatchObject({ status: "retry", errorCode: "PIPELINE_FILTER_FAILED" });
    await db.job.update({ where: { id: next.jobId }, data: { runAfter: new Date(0) } });
    expect(await runJobOnce(db, "pipeline-worker", createJobHandlers(db, stages))).toMatchObject({ status: "succeeded" });
    expect(await db.feedItem.count()).toBe(1);
  });
  it("enqueues jobs idempotently and rejects conflicting reuse of a dedupe key", async () => {
    const input = { kind: "test", dedupeKey: "job-1", payload: { a: 1, b: 2 } };
    const results = await Promise.all([enqueueJob(db, input), enqueueJob(db, { ...input, payload: { b: 2, a: 1 } })]);
    expect(results[0].id).toBe(results[1].id);
    expect(await db.job.count()).toBe(1);
    await expect(enqueueJob(db, { ...input, payload: {} })).rejects.toThrow("DEDUPE_KEY_CONFLICT");
    await expect(enqueueJob(db, { ...input, kind: "other" })).rejects.toThrow("DEDUPE_KEY_CONFLICT");
  });
  it("claims a due job only once and leaves future jobs pending", async () => {
    const queued = await enqueueJob(db, { kind: "test", dedupeKey: "due" });
    await db.job.create({ data: { kind: "test", dedupeKey: "future", runAfter: new Date("2099-01-01") } });
    const results = await Promise.all([claimJob(db, "one"), claimJob(db, "two")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ id: queued.id, attempts: 1 });
    expect(await db.job.findUniqueOrThrow({ where: { dedupeKey: "future" } })).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("executes a registered handler and clears the lease on completion", async () => {
    const job = await enqueueJob(db, { kind: "database.check", dedupeKey: "check" });
    expect(await runJobOnce(db, "worker", createJobHandlers(db))).toMatchObject({ status: "succeeded", jobId: job.id });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "succeeded", attempts: 1, lockedBy: null, lockedUntil: null });
    expect(await runJobOnce(db, "worker", {})).toEqual({ status: "idle" });
  });
  it("retries sanitized failures with backoff and fails at the attempt limit", async () => {
    const job = await enqueueJob(db, { kind: "test", dedupeKey: "fails", maxAttempts: 2 });
    const handlers = { test: async () => { throw new Error("password=secret"); } };
    expect(await runJobOnce(db, "worker", handlers)).toMatchObject({ status: "retry", errorCode: "HANDLER_FAILED" });
    const retry = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retry).toMatchObject({ attempts: 1, lastErrorCode: "HANDLER_FAILED", lockedBy: null, completedAt: null });
    expect(retry.runAfter.getTime() - retry.updatedAt.getTime()).toBeGreaterThanOrEqual(4900);
    expect(await claimJob(db, "worker")).toBeNull();
    await db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
    expect(await runJobOnce(db, "worker", handlers)).toMatchObject({ status: "failed" });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).completedAt).not.toBeNull();
    expect(await claimJob(db, "worker")).toBeNull();
  });
  it("recovers expired leases and fences off old claims even on the same worker", async () => {
    const job = await enqueueJob(db, { kind: "test", dedupeKey: "recover", maxAttempts: 2 });
    const old = (await claimJob(db, "same-worker"))!;
    expect(await renewJobLease(db, old)).toBe(true);
    await db.job.update({ where: { id: job.id }, data: { lockedUntil: new Date(0) } });
    expect(await renewJobLease(db, old)).toBe(false);
    expect(await finishJob(db, old)).toBe("lease_lost");
    expect(await recoverExpiredJobs(db)).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "retry", lastErrorCode: "LEASE_EXPIRED", attempts: 1 });
    await db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
    const current = (await claimJob(db, "same-worker"))!;
    expect(current.lockedBy).not.toBe(old.lockedBy);
    expect(await finishJob(db, old, new JobError("STALE"))).toBe("lease_lost");
    expect(await finishJob(db, current)).toBe("succeeded");
  });
  it("terminally fails exhausted crash recovery and unsupported or invalid jobs", async () => {
    const job = await enqueueJob(db, { kind: "test", dedupeKey: "last-attempt", maxAttempts: 1 });
    await claimJob(db, "worker");
    await db.job.update({ where: { id: job.id }, data: { lockedUntil: new Date(0) } });
    await recoverExpiredJobs(db);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed", attempts: 1, lockedBy: null });
    await enqueueJob(db, { kind: "unknown", dedupeKey: "unknown" });
    expect(await runJobOnce(db, "worker", createJobHandlers(db))).toMatchObject({ status: "failed", errorCode: "UNSUPPORTED_JOB_KIND" });
    await enqueueJob(db, { kind: "database.check", dedupeKey: "invalid", payload: { unsupported: true } });
    expect(await runJobOnce(db, "worker", createJobHandlers(db))).toMatchObject({ status: "failed", errorCode: "INVALID_JOB_PAYLOAD" });
  });
  it("stops claiming on shutdown and retries cooperative interrupted handlers", async () => {
    const job = await enqueueJob(db, { kind: "test", dedupeKey: "stop" });
    const stop = new AbortController();
    stop.abort();
    expect(await runJobOnce(db, "worker", {}, stop.signal)).toEqual({ status: "stopped" });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(0);
    const during = new AbortController();
    expect(await runJobOnce(db, "worker", { test: async () => { during.abort(); } }, during.signal)).toMatchObject({ status: "retry", errorCode: "JOB_INTERRUPTED" });
  });
  async function researchInbox() {
    await seedStarterUniverse(db);
    await storeAnnouncements(db, [
      { sourceId: "results", title: "TCS - Results", description: "Quarterly results announced", url: "https://example.com/results", publishedAt: null },
      { sourceId: "routine", title: "TCS - Trading Window Closure", description: null, url: "https://example.com/routine", publishedAt: null },
      { sourceId: "review", title: "TCS - Update", description: null, url: "https://example.com/review", publishedAt: null },
      { sourceId: "unmatched", title: "UNKNOWN - Results", description: null, url: "https://example.com/unknown", publishedAt: null },
    ]);
    await matchStoredAnnouncements(db);
    await filterStoredAnnouncements(db);
  }
  function researchProvider() {
    return {
      name: "test", model: "test-model",
      analyze: vi.fn<ResearchProvider["analyze"]>().mockResolvedValue({
        assessment: {
          classification: "INVESTIGATE", summary: "Review this announcement.", significance: "Insufficient detail to establish financial impact.",
          risks: ["Price and valuation are unknown."], uncertainties: ["Full filing has not been read."], evidenceIds: ["announcement"],
        }, inputTokens: 100, outputTokens: 70,
      }),
    } satisfies ResearchProvider;
  }
  it("persists validated research with authoritative evidence and skips identical requests", async () => {
    await researchInbox();
    const provider = researchProvider();
    expect(await analyzeStoredAnnouncements(db, provider)).toMatchObject({ analyzed: 2, attempted: 2, failed: 0 });
    const rows = await db.feedResearch.findMany({ include: { feedItem: true } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.evidence).toEqual([{ id: "announcement", source: NSE_SOURCE, sourceId: row.feedItem.sourceId, title: row.feedItem.title, url: row.feedItem.url }]);
      expect(row.inputSnapshot).toMatchObject({ announcement: { publishedAt: null }, stock: { symbol: "TCS" } });
      expect(row.inputTokens).toBe(100);
      expect(row.inputHash).toHaveLength(64);
    }
    expect(await analyzeStoredAnnouncements(db, provider)).toMatchObject({ analyzed: 0, attempted: 0, skipped: 2 });
    expect(provider.analyze).toHaveBeenCalledTimes(2);
  });
  it("bounds paid attempts, leaves failures retryable and stores no invalid assessment", async () => {
    await researchInbox();
    const provider = researchProvider();
    provider.analyze.mockRejectedValue(new ResearchError("provider_http_error", 429));
    expect(await analyzeStoredAnnouncements(db, provider, 1)).toMatchObject({ attempted: 1, analyzed: 0, failed: 1, failures: [{ code: "provider_http_error", httpStatus: 429 }] });
    expect(await db.feedResearch.count()).toBe(0);
    const invalid = researchProvider();
    const result = await invalid.analyze({} as never);
    invalid.analyze.mockResolvedValue({ ...result, assessment: { ...result.assessment, evidenceIds: ["invented"] } as never });
    expect(await analyzeStoredAnnouncements(db, invalid, 1)).toMatchObject({ analyzed: 0, failed: 1 });
    expect(await db.feedResearch.count()).toBe(0);
    expect(await analyzeStoredAnnouncements(db, researchProvider(), 1)).toMatchObject({ analyzed: 1, attempted: 1 });
  });
  it("rechecks eligibility after generation before saving and allows changed inputs to be researched", async () => {
    await researchInbox();
    const provider = researchProvider();
    const result = await provider.analyze({} as never);
    provider.analyze.mockImplementation(async (input) => {
      await db.instrument.updateMany({ where: { symbol: input.stock.symbol }, data: { active: false } });
      return result;
    });
    expect(await analyzeStoredAnnouncements(db, provider, 1)).toMatchObject({ analyzed: 0, skipped: 1 });
    expect(await db.feedResearch.count()).toBe(0);
    await db.instrument.updateMany({ where: { symbol: "TCS" }, data: { active: true } });
    const valid = researchProvider();
    await analyzeStoredAnnouncements(db, valid);
    await db.instrument.updateMany({ where: { symbol: "TCS" }, data: { name: "Updated stock display name" } });
    expect(await analyzeStoredAnnouncements(db, valid)).toMatchObject({ analyzed: 2, attempted: 2 });
    expect(await db.feedResearch.count()).toBe(4);
  });
  it("filters matched announcements with reasons while preserving the raw inbox", async () => {
    await seedStarterUniverse(db);
    await storeAnnouncements(db, [
      { sourceId: "results", title: "TCS - Financial Results", url: "https://example.com/results", description: "Quarterly results", publishedAt: new Date("2026-11-02T03:15:00Z") },
      { sourceId: "routine", title: "TCS - Trading Window Closure", url: "https://example.com/window", description: null, publishedAt: null },
      { sourceId: "unknown-subject", title: "TCS - Update", url: "https://example.com/update", description: null, publishedAt: null },
      { sourceId: "unknown-stock", title: "NEWCO - Trading Window Closure", url: "https://example.com/unknown", description: null, publishedAt: null },
    ]);
    await matchStoredAnnouncements(db);
    const before = await db.feedItem.findMany({ orderBy: { id: "asc" } });
    const checked = new Date("2026-11-02T12:00:00Z");
    expect(await filterStoredAnnouncements(db, () => checked)).toEqual({ keep: 1, routine: 1, review: 1 });
    const after = await db.feedItem.findMany({ orderBy: { id: "asc" } });
    for (const [i, row] of after.entries()) {
      const original = before[i];
      expect(row).toMatchObject({ title: original.title, url: original.url, description: original.description, publishedAt: original.publishedAt, discoveredAt: original.discoveredAt, instrumentId: original.instrumentId });
      if (row.matchStatus === "matched") {
        expect(row.relevanceRuleVersion).toBe(RELEVANCE_RULE_VERSION);
        expect(row.relevanceReason).toBeTruthy();
        expect(row.relevanceCheckedAt).toEqual(checked);
      } else {
        expect(row.relevanceStatus).toBe("pending");
        expect(row.relevanceCheckedAt).toBeNull();
      }
    }
    expect(await filterStoredAnnouncements(db)).toEqual({ keep: 0, routine: 0, review: 0 });
    expect(await db.feedItem.findMany({ orderBy: { id: "asc" } })).toEqual(after);
  });
  it("reprocesses decisions from older rule versions without replacing current decisions", async () => {
    await seedStarterUniverse(db);
    const instrument = await db.instrument.findFirstOrThrow({ where: { symbol: "TCS" } });
    const old = await db.feedItem.create({ data: {
      source: NSE_SOURCE, sourceId: "old-rules", title: "TCS - Financial Results", url: "https://example.com/old",
      matchStatus: "matched", instrumentId: instrument.id, relevanceStatus: "routine", relevanceReason: "OLD_RULE",
      relevanceRuleVersion: "old-version", relevanceCheckedAt: new Date("2026-01-01T00:00:00Z"),
    } });
    expect(await filterStoredAnnouncements(db)).toEqual({ keep: 1, routine: 0, review: 0 });
    expect(await db.feedItem.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ relevanceStatus: "keep", relevanceRuleVersion: RELEVANCE_RULE_VERSION });
  });
  it("filters across batches and repeated or overlapping runs count each item once", async () => {
    await seedStarterUniverse(db);
    await storeAnnouncements(db, Array.from({ length: 103 }, (_, i) => ({
      sourceId: `routine-${i}`, title: "TCS - Trading Window", url: `https://example.com/${i}`, description: null, publishedAt: null,
    })));
    await matchStoredAnnouncements(db);
    const runs = await Promise.all([filterStoredAnnouncements(db), filterStoredAnnouncements(db)]);
    expect(runs.reduce((sum, result) => sum + result.routine, 0)).toBe(103);
    expect(await db.feedItem.count({ where: { relevanceStatus: "routine" } })).toBe(103);
    expect(await db.feedItem.count()).toBe(103);
  });
  it("leaves inactive, out-of-universe, foreign-feed, unmatched, and ambiguous items pending", async () => {
    await seedStarterUniverse(db);
    const tcs = await db.instrument.findFirstOrThrow({ where: { symbol: "TCS" } });
    const inactive = await db.instrument.findFirstOrThrow({ where: { symbol: "INFY" } });
    const excluded = await db.instrument.findFirstOrThrow({ where: { symbol: "HDFCBANK" } });
    await db.instrument.update({ where: { id: inactive.id }, data: { active: false } });
    await db.instrument.update({ where: { id: excluded.id }, data: { inUniverse: false } });
    const base = { source: NSE_SOURCE, title: "TCS - Trading Window", url: "https://example.com/notice" };
    await db.feedItem.createMany({ data: [
      { ...base, sourceId: "inactive", matchStatus: "matched", instrumentId: inactive.id },
      { ...base, sourceId: "excluded", matchStatus: "matched", instrumentId: excluded.id },
      { ...base, source: "other", sourceId: "other-feed", matchStatus: "matched", instrumentId: tcs.id },
      { ...base, sourceId: "unmatched", matchStatus: "unmatched" },
      { ...base, sourceId: "ambiguous", matchStatus: "ambiguous" },
    ] });
    expect(await filterStoredAnnouncements(db)).toEqual({ keep: 0, routine: 0, review: 0 });
    expect(await db.feedItem.count({ where: { relevanceStatus: "pending" } })).toBe(5);
  });
  it("enforces complete relevance metadata and a matched issuer in the database", async () => {
    await seedStarterUniverse(db);
    const stock = await db.instrument.findFirstOrThrow();
    const base = { source: NSE_SOURCE, sourceId: "invalid-relevance", title: "Results", url: "https://example.com" };
    await rejectsConstraint(db.feedItem.create({ data: { ...base, matchStatus: "matched", instrumentId: stock.id, relevanceStatus: "keep" } }), "feed_items_relevance_complete");
    await rejectsConstraint(db.feedItem.create({ data: { ...base, relevanceStatus: "routine", relevanceReason: "RULE", relevanceRuleVersion: "v1", relevanceCheckedAt: new Date() } }), "feed_items_relevance_requires_match");
  });
  it("seeds starter stocks repeatably without replacing existing settings or memberships", async () => {
    const existing = await db.instrument.create({ data: { exchange: "NSE", symbol: "TCS", name: "Custom name", inUniverse: false } });
    expect(await seedStarterUniverse(db)).toEqual({ inserted: 5 });
    expect(await seedStarterUniverse(db)).toEqual({ inserted: 0 });
    expect(await db.instrument.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ name: "Custom name", inUniverse: false });
    expect(await db.instrument.count()).toBe(6);
  });
  it("parses, stores and matches an announcement while preserving source text and dates", async () => {
    await seedStarterUniverse(db);
    const { items } = parseAnnouncements('<rss><channel><item><guid>tcs-results</guid><title>TCS - Financial Results</title><link>https://example.com/results</link><pubDate>Mon, 02 Nov 2026 08:45:00 +0530</pubDate></item></channel></rss>');
    await storeAnnouncements(db, items);
    const original = await db.feedItem.findFirstOrThrow();
    expect(await matchStoredAnnouncements(db)).toEqual({ matched: 1, unmatched: 0, ambiguous: 0 });
    const item = await db.feedItem.findFirstOrThrow({ include: { instrument: true } });
    expect(item).toMatchObject({ matchStatus: "matched", title: original.title, publishedAt: original.publishedAt, discoveredAt: original.discoveredAt, instrument: { symbol: "TCS" } });
    expect(item.matchCheckedAt).not.toBeNull();
    expect(await matchStoredAnnouncements(db)).toEqual({ matched: 0, unmatched: 0, ambiguous: 0 });
    expect((await db.feedItem.findFirstOrThrow()).matchCheckedAt).toEqual(item.matchCheckedAt);
  });
  it("retains unmatched and ambiguous items and rematches after universe expansion", async () => {
    await seedStarterUniverse(db);
    await db.instrument.create({ data: { exchange: "NSE", symbol: "INFY2", name: "Infosys Ltd", inUniverse: true } });
    await storeAnnouncements(db, [
      { sourceId: "unknown", title: "NEWCO - Results", url: "https://example.com/new", description: null, publishedAt: null },
      { sourceId: "ambiguous", title: "Infosys Limited - Results", url: "https://example.com/ambiguous", description: null, publishedAt: null },
    ]);
    expect(await matchStoredAnnouncements(db)).toEqual({ matched: 0, unmatched: 1, ambiguous: 1 });
    expect(await db.feedItem.count({ where: { instrumentId: null } })).toBe(2);
    await db.instrument.create({ data: { exchange: "NSE", symbol: "NEWCO", name: "New Company Limited", inUniverse: true } });
    expect(await matchStoredAnnouncements(db)).toEqual({ matched: 1, unmatched: 0, ambiguous: 1 });
  });
  it("matches only active universe equities from NSE announcement feeds, across batches", async () => {
    await seedStarterUniverse(db);
    await db.instrument.update({ where: { exchange_symbol: { exchange: "NSE", symbol: "INFY" } }, data: { active: false } });
    await db.instrument.update({ where: { exchange_symbol: { exchange: "NSE", symbol: "HDFCBANK" } }, data: { inUniverse: false } });
    await storeAnnouncements(db, Array.from({ length: 103 }, (_, i) => ({ sourceId: `batch-${i}`, title: "TCS - Update", url: `https://example.com/${i}`, description: null, publishedAt: null })));
    await storeAnnouncements(db, ["INFY", "HDFCBANK"].map((symbol) => ({ sourceId: symbol, title: `${symbol} - Update`, url: `https://example.com/${symbol}`, description: null, publishedAt: null })));
    await db.feedItem.create({ data: { source: "other", sourceId: "other", title: "TCS - Update", url: "https://example.com/other" } });
    expect(await matchStoredAnnouncements(db)).toEqual({ matched: 103, unmatched: 2, ambiguous: 0 });
    expect((await db.feedItem.findFirstOrThrow({ where: { source: "other" } })).matchStatus).toBe("pending");
    expect(await db.feedItem.count({ where: { source: NSE_SOURCE } })).toBe(105);
  });
  it("requires a universe and enforces consistent match state in the database", async () => {
    await expect(matchStoredAnnouncements(db)).rejects.toThrow("No active NSE stocks");
    await expect(db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "invalid", title: "Results", url: "https://example.com", matchStatus: "matched" } })).rejects.toThrow();
  });
  it("stores unmatched announcements and deduplicates concurrent ingestion without changing discovery time", async () => {
    const item = { sourceId: "filing-1", title: "Example results", url: "https://example.com/1", description: null, publishedAt: null };
    const results = await Promise.all([storeAnnouncements(db, [item, item]), storeAnnouncements(db, [item])]);
    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    const first = await db.feedItem.findFirstOrThrow();
    expect(await storeAnnouncements(db, [item])).toEqual({ received: 1, inserted: 0, duplicates: 1 });
    expect(await db.feedItem.count()).toBe(1);
    expect((await db.feedItem.findFirstOrThrow()).discoveredAt).toEqual(first.discoveredAt);
    expect(first.publishedAt).toBeNull();
  });
  it("can deploy migrations twice without applying a migration twice", async () => {
    const before = await db.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    await migrate();
    const after = await db.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(before[0].total).toBeGreaterThan(BigInt(0));
    expect(after[0].total).toBe(before[0].total);
  }, 30000);

  it("keeps the Prisma schema in sync with the migrated database", async () => {
    const result = await run(process.execPath, [
      "node_modules/prisma/build/index.js", "migrate", "diff",
      "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code",
    ], { env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 30000 });
    expect(result.stdout).toContain("No difference detected");
  }, 30000);

  it("preserves exact decimal prices, large provider tokens, and missing market context", async () => {
    const event = await signal();
    expect(event.price?.toFixed(6)).toBe("102.123456");
    expect(event.benchmarkReturnPct).toBeNull();
    expect(event.relativeVolume).toBeNull();
    expect(event.observedAt.toISOString()).toBe("2026-10-28T04:00:00.000Z");
    const token = BigInt("9007199254740993");
    const row = await db.instrument.update({ where: { id: event.instrumentId }, data: { kiteToken: token } });
    expect(row.kiteToken).toBe(token);
  });

  it("enforces instrument and signal identities", async () => {
    const instrument = await stock();
    await expect(stock()).rejects.toMatchObject({ code: "P2002" });
    await db.signal.create({ data: movement(instrument.id) });
    await expect(db.signal.create({ data: movement(instrument.id) })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows announcement signals without prices and prevents cross-stock references", async () => {
    const instrument = await stock();
    const data = { instrumentId: instrument.id, source: "NSE", sourceId: "filing-1", title: "Results", url: "https://example.com/filing", publishedAt: new Date("2026-10-28T13:00:00Z") };
    const announcement = await db.announcement.create({ data });
    const event = await db.signal.create({ data: {
      instrumentId: instrument.id, origin: "announcement", announcementId: announcement.id,
      dedupeKey: "announcement:1", detectorVersion: "filings-v1", observedAt: new Date("2026-10-28T13:01:00Z"),
    } });
    expect(event.price).toBeNull();
    await expect(db.announcement.create({ data })).rejects.toMatchObject({ code: "P2002" });
    const another = await stock("OTHER");
    await expect(db.signal.create({ data: {
      instrumentId: another.id, origin: "announcement", announcementId: announcement.id,
      dedupeKey: "announcement:wrong-stock", detectorVersion: "v1", observedAt: new Date(),
    } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects movement events with missing prices, negative prices, or backwards windows", async () => {
    const instrument = await stock();
    const base = movement(instrument.id);
    await rejectsConstraint(db.signal.create({ data: { ...base, price: null } }), "signals_origin_source_check");
    await rejectsConstraint(db.signal.create({ data: { ...base, price: "-1" } }), "signals_positive_prices");
    await rejectsConstraint(db.signal.create({ data: { ...base, windowStart: new Date("2026-10-29T00:00:00Z") } }), "signals_window_order");
  });

  it("stores evidence once per signal and blocks orphan references", async () => {
    const event = await signal();
    const data = { signalId: event.id, kind: "news" as const, title: "Source", url: "https://example.com/news" };
    await db.signalEvidence.create({ data });
    await expect(db.signalEvidence.create({ data })).rejects.toMatchObject({ code: "P2002" });
    await expect(db.signal.delete({ where: { id: event.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("supports non-AI alerts and refuses an analysis belonging to another signal", async () => {
    const notification = await alert();
    expect(notification.analysisId).toBeNull();
    const instrument = await stock("OTHER");
    const otherSignal = await db.signal.create({ data: movement(instrument.id, "other-signal") });
    const analysis = await db.analysis.create({ data: { signalId: otherSignal.id, provider: "test", model: "test", promptVersion: "v1", summary: "Unverified" } });
    await expect(db.alert.update({ where: { id: notification.id }, data: { analysisId: analysis.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("delivery, recovery, and feedback integrity", () => {
  it("requires a finished delivery and Telegram message ID before marking an attempt sent", async () => {
    const notification = await alert();
    const data = { alertId: notification.id, attempt: 1, status: "sent" as const, startedAt: new Date("2026-10-28T04:00:00Z"), finishedAt: new Date("2026-10-28T04:00:01Z") };
    await rejectsConstraint(db.deliveryAttempt.create({ data }), "delivery_attempts_sent_message");
    await db.deliveryAttempt.create({ data: { ...data, telegramMessageId: "42" } });
    await expect(db.deliveryAttempt.create({ data: { alertId: notification.id, attempt: 1 } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("persists retry state and rejects duplicate jobs, missing leases, and exhausted retry counts", async () => {
    const data = { kind: "investigate", dedupeKey: "job:1" };
    const job = await db.job.create({ data });
    expect(job.status).toBe("pending");
    await expect(db.job.create({ data })).rejects.toMatchObject({ code: "P2002" });
    await rejectsConstraint(db.job.update({ where: { id: job.id }, data: { status: "running" } }), "jobs_lease_fields");
    await db.job.update({ where: { id: job.id }, data: { status: "running", lockedBy: "worker-1", lockedUntil: new Date(Date.now() + 30000), attempts: 1 } });
    const retry = await db.job.update({ where: { id: job.id }, data: { status: "retry", lockedBy: null, lockedUntil: null, runAfter: new Date(Date.now() + 60000) } });
    expect(retry.attempts).toBe(1);
    await rejectsConstraint(db.job.update({ where: { id: job.id }, data: { attempts: 6 } }), "jobs_attempts_bounds");
    await rejectsConstraint(db.job.update({ where: { id: job.id }, data: { status: "succeeded" } }), "jobs_completion_fields");
  });

  it("rolls back signal and work creation together", async () => {
    const instrument = await stock();
    await expect(db.$transaction(async (tx) => {
      const event = await tx.signal.create({ data: movement(instrument.id) });
      await tx.job.create({ data: { kind: "investigate", dedupeKey: "job:rollback", signalId: event.id } });
      throw new Error("simulated failure");
    })).rejects.toThrow("simulated failure");
    expect(await db.signal.count()).toBe(0);
    expect(await db.job.count()).toBe(0);
  });

  it("upserts one current feedback choice per alert and Telegram user", async () => {
    const notification = await alert();
    const choice = { alertId: notification.id, telegramUserId: "9007199254740993", useful: true };
    await db.feedback.create({ data: choice });
    await db.feedback.upsert({ where: { alertId_telegramUserId: { alertId: choice.alertId, telegramUserId: choice.telegramUserId } }, create: choice, update: { useful: false, updatedAt: new Date() } });
    const rows = await db.feedback.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].useful).toBe(false);
    expect(rows[0].telegramUserId).toBe(choice.telegramUserId);
  });

  it("keeps polling checkpoints unique per source and scope", async () => {
    const data = { source: "NSE", scope: "nifty500", cursor: { lastId: "123" } };
    await db.pollingCheckpoint.create({ data });
    await expect(db.pollingCheckpoint.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("performance outcome integrity", () => {
  it("requires supported horizons and complete measurements, with one result per alert and horizon", async () => {
    const notification = await alert();
    const base = { alertId: notification.id, methodologyVersion: "v1", horizonTradingDays: 1 };
    await rejectsConstraint(db.performanceOutcome.create({ data: { ...base, horizonTradingDays: 2 } }), "performance_outcomes_horizon_check");
    await rejectsConstraint(db.performanceOutcome.create({ data: { ...base, status: "completed" } }), "performance_outcomes_completed_fields");
    await rejectsConstraint(db.performanceOutcome.create({ data: { ...base, status: "unavailable" } }), "performance_outcomes_unavailable_reason");
    await db.performanceOutcome.create({ data: { ...base, status: "completed", referenceSession: new Date("2026-10-28T00:00:00Z"), dueSession: new Date("2026-10-29T00:00:00Z"), referenceAt: new Date("2026-10-28T04:00:00Z"), observedAt: new Date("2026-10-29T04:00:00Z"), referencePrice: "100", observedPrice: "105", stockReturnPct: "5", measuredAt: new Date() } });
    await expect(db.performanceOutcome.create({ data: base })).rejects.toMatchObject({ code: "P2002" });
  });

  it("does not allow excess returns without benchmark prices", async () => {
    const notification = await alert();
    await rejectsConstraint(db.performanceOutcome.create({ data: {
      alertId: notification.id, methodologyVersion: "v1", horizonTradingDays: 5,
      stockReturnPct: "5", benchmarkReturnPct: "2", excessReturnPct: "3",
    } }), "performance_outcomes_benchmark_fields");
  });
});

describe("MVP workflow regression checks", () => {
  it("atomically replaces membership, preserves removed research identities and rejects older imports", async () => {
    const { importUniverse } = await import("../src/lib/instruments/universe");
    const input = { source: "supplied official membership", effectiveDate: "2026-11-04", members: [{ symbol: "EXAMPLE", name: "Example" }, { symbol: "INDEX", name: "Index", kind: "index", yahooSymbol: "^NSEI" }] };
    const first = await importUniverse(db, input);
    expect(first.duplicate).toBe(false);
    const original = await db.instrument.findUniqueOrThrow({ where: { exchange_symbol: { exchange: "NSE", symbol: "EXAMPLE" } } });
    expect((await importUniverse(db, input)).duplicate).toBe(true);
    await importUniverse(db, { ...input, effectiveDate: "2026-11-05", members: [{ symbol: "OTHER", name: "Other" }] });
    expect((await db.instrument.findUniqueOrThrow({ where: { id: original.id } })).inUniverse).toBe(false);
    await expect(importUniverse(db, { ...input, source: "older" })).rejects.toThrow("OLDER_MEMBERSHIP_REJECTED");
  });
  it("bounds each full-universe slot, rotates after restart, and does not grow work on repeated ticks", async () => {
    const { schedulePriceCollection } = await import("../src/lib/market-data/scheduler");
    await db.instrument.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ exchange: "NSE", symbol: `STOCK${String(i).padStart(2, "0")}`, name: "Synthetic", active: true, inUniverse: true })) });
    const calendar = parseCalendar({ source: "synthetic", coverageStart: "2026-11-01", coverageEnd: "2026-11-30", holidays: [], specialSessions: [] });
    const at = new Date("2026-11-04T04:00:00Z");
    expect((await schedulePriceCollection(db, calendar, [], 7, at, 10)).enqueued).toBe(10);
    expect((await schedulePriceCollection(db, calendar, [], 7, new Date(at.getTime() + 10000), 10)).enqueued).toBe(0);
    expect((await schedulePriceCollection(db, calendar, [], 7, new Date(at.getTime() + 300000), 10)).enqueued).toBe(10);
    const jobs = await db.job.findMany({ orderBy: { runAfter: "asc" } });
    expect(new Set(jobs.map((j) => (j.payload as { symbol: string }).symbol)).size).toBe(20);
  });
  it("keeps successful source imports when another source fails and matches BSE codes without name guessing", async () => {
    const { collectSource } = await import("../src/lib/announcements/sources");
    await db.feedSource.upsert({ where: { id: "bse" }, create: { id: "bse", kind: "bse", name: "BSE", enabled: true }, update: { enabled: true } });
    const s = await db.instrument.create({ data: { exchange: "NSE", symbol: "EXAMPLE", name: "Example", bseCode: "500001", inUniverse: true } });
    const adapter = { fetch: async () => ({ items: [{ sourceId: "synthetic-bse", issuerCode: "500001", title: "Results", url: "https://example.com/evidence", description: null, publishedAt: null }], skipped: 0 }) };
    expect((await collectSource(db, "bse", undefined, adapter)).inserted).toBe(1);
    expect((await collectSource(db, "bse", undefined, adapter)).duplicates).toBe(1);
    await matchStoredAnnouncements(db);
    expect((await db.feedItem.findFirstOrThrow()).instrumentId).toBe(s.id);
    await expect(collectSource(db, "bse", undefined, { fetch: async () => { throw new Error("secret"); } })).rejects.toThrow();
    expect(await db.feedItem.count()).toBe(1);
    expect((await db.pollingCheckpoint.findUniqueOrThrow({ where: { source_scope: { source: "feed-source", scope: "bse" } } })).lastErrorCode).toBe("SOURCE_COLLECTION_FAILED");
  });
  it("cancels pending work before claim and fences cancellation of already-running work", async () => {
    const a = await enqueueJob(db, { kind: "database.check", dedupeKey: "cancel-pending" });
    await db.job.update({ where: { id: a.id }, data: { cancelRequestedAt: new Date() } });
    await recoverExpiredJobs(db);
    expect(await claimJob(db, "test")).toBeNull();
    expect((await db.job.findUniqueOrThrow({ where: { id: a.id } })).lastErrorCode).toBe("JOB_CANCELLED");
    const b = await enqueueJob(db, { kind: "database.check", dedupeKey: "cancel-running" });
    const running = (await claimJob(db, "test"))!;
    await db.job.update({ where: { id: b.id }, data: { cancelRequestedAt: new Date() } });
    expect(await finishJob(db, running)).toBe("failed");
    expect((await db.job.findUniqueOrThrow({ where: { id: b.id } })).lastErrorCode).toBe("JOB_CANCELLED");
  });
});

describe("review preferences feedback and follow-up regressions", () => {
  it("retains version-specific review and feedback and rejects stale form updates", async () => {
    const { setReadState } = await import("../src/lib/dashboard/read-state");
    const { saveFeedback } = await import("../src/lib/dashboard/feedback");
    const feed = await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "review", title: "Example", url: "https://example.com" } });
    const input = { kind: "announcement", id: feed.id, version: "source" };
    expect((await setReadState(db, { ...input, state: "read" })).ok).toBe(true);
    expect((await saveFeedback(db, { ...input, choice: "useful", reason: "Helpful" })).ok).toBe(true);
    const r = await db.feedResearch.create({ data: { feedItemId: feed.id, provider: "synthetic", model: "test", promptVersion: "test", inputHash: "test", inputSnapshot: {}, classification: "WATCH", summary: "test", significance: "test", risks: [], uncertainties: [], evidence: [] } });
    expect((await setReadState(db, { ...input, state: "read" })).ok).toBe(false);
    expect((await saveFeedback(db, { ...input, choice: "not-useful" })).ok).toBe(false);
    expect((await setReadState(db, { ...input, version: r.id, state: "read" })).ok).toBe(true);
    expect(await db.researchFeedback.count()).toBe(1);
    expect((await getResearchDetail(db, "announcement", feed.id))?.isRead).toBe(true);
  });
  it("applies saved frontend preferences without deleting research or watchlist state", async () => {
    const { changeWatchlist, savePreferences, defaultPreferences } = await import("../src/lib/dashboard/preferences");
    const { getFrontendAlerts } = await import("../src/lib/dashboard/alerts");
    const instrument = await db.instrument.create({ data: { exchange: "NSE", symbol: "EXAMPLE", name: "Example", active: true, inUniverse: true } });
    const feed = await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "alert", matchStatus: "matched", matchCheckedAt: new Date(), title: "Example", url: "https://example.com", instrumentId: instrument.id } });
    await db.feedResearch.create({ data: { feedItemId: feed.id, provider: "synthetic", model: "test", promptVersion: "test", inputHash: "test", inputSnapshot: {}, classification: "WATCH", summary: "test", significance: "test", risks: [], uncertainties: [], evidence: [] } });
    expect((await getFrontendAlerts(db, { read: "all", page: 1 })).total).toBe(1);
    await savePreferences(db, { ...defaultPreferences, watchlistOnly: true });
    expect((await getFrontendAlerts(db, { read: "all", page: 1 })).total).toBe(0);
    await changeWatchlist(db, { instrumentId: instrument.id, operation: "add" });
    expect((await getFrontendAlerts(db, { read: "all", page: 1 })).total).toBe(1);
    await changeWatchlist(db, { instrumentId: instrument.id, operation: "remove" });
    expect(await db.feedResearch.count()).toBe(1);
  });
  it("counts later trading days across holidays and excludes late-imported reference quotes", async () => {
    const { updateResearchFollowUps } = await import("../src/lib/research/followups");
    const calendar = parseCalendar({ source: "synthetic", coverageStart: "2026-11-01", coverageEnd: "2026-12-31", holidays: [{ date: "2026-11-05", name: "Synthetic closure" }], specialSessions: [] });
    const s = await db.instrument.create({ data: { exchange: "NSE", symbol: "EXAMPLE", name: "Example", active: true, inUniverse: true } });
    const published = new Date("2026-11-04T04:00:00Z");
    const f = await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "outcome", matchStatus: "matched", matchCheckedAt: published, title: "Example", url: "https://example.com", instrumentId: s.id } });
    await db.feedResearch.create({ data: { feedItemId: f.id, createdAt: published, provider: "synthetic", model: "test", promptVersion: "test", inputHash: "test", inputSnapshot: {}, classification: "WATCH", summary: "test", significance: "test", risks: [], uncertainties: [], evidence: [] } });
    const snapshot = async (quoteTime: string, recordedAt: string, price: string, key: string) => db.marketSnapshotRecord.create({ data: { instrumentId: s.id, provider: "synthetic", providerSymbol: "EXAMPLE", contentHash: key, retrievedAt: new Date(quoteTime), recordedAt: new Date(recordedAt), requestedDays: 1, skippedBars: 0, quoteTime: new Date(quoteTime), quotePrice: price, quoteAgeSeconds: 0, quoteFreshness: "recent", quoteDelayStatus: "unknown" } });
    await snapshot("2026-11-04T04:01:00Z", "2026-11-04T04:01:00Z", "100", "reference");
    await updateResearchFollowUps(db, calendar, 25, new Date("2026-11-04T04:05:00Z"));
    let row = await db.researchFollowUp.findFirstOrThrow({ where: { horizonSessions: 1 } });
    expect(row.dueAt?.toISOString()).toBe("2026-11-06T10:05:00.000Z");
    await snapshot("2026-11-06T09:59:00Z", "2026-11-06T09:59:01Z", "105", "later");
    await updateResearchFollowUps(db, calendar, 25, new Date("2026-11-06T10:06:00Z"));
    row = await db.researchFollowUp.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.status).toBe("measured"); expect(row.changePct?.toString()).toBe("5");
    expect(row.comparison).toMatchObject({ corporateActions: "unverified", benchmark: { status: "unavailable" } });
    // A second research version has no contemporaneous baseline; a later import cannot manufacture one.
    await db.feedResearch.create({ data: { feedItemId: f.id, createdAt: new Date("2026-11-04T05:00:00Z"), provider: "synthetic", model: "test", promptVersion: "test", inputHash: "second", inputSnapshot: {}, classification: "WATCH", summary: "test", significance: "test", risks: [], uncertainties: [], evidence: [] } });
    await snapshot("2026-11-04T05:01:00Z", "2026-11-06T09:00:00Z", "101", "late-import");
    await updateResearchFollowUps(db, calendar, 25, new Date("2026-11-06T10:06:00Z"));
    expect(await db.researchFollowUp.count({ where: { reason: "REFERENCE_WINDOW_MISSING" } })).toBe(3);
  });
  it("does not requeue cancelled failed work without a deliberate audited retry", async () => {
    const { retryFailedJob } = await import("../src/lib/jobs/retry");
    const job = await enqueueJob(db, { kind: "database.check", dedupeKey: "manual-retry" });
    const at = new Date();
    await db.job.update({ where: { id: job.id }, data: { cancelRequestedAt: at } });
    await recoverExpiredJobs(db);
    const failed = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect((await retryFailedJob(db, { id: job.id, confirmed: true, finishedAt: failed.completedAt!.toISOString(), reason: "Explicit retry" })).ok).toBe(true);
    const result = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(result.status).toBe("pending"); expect(result.cancelRequestedAt).toBeNull();
    expect(await db.jobRetryRequest.count()).toBe(1);
  });
});

describe("aligned comparison evidence", () => {
  it("excludes future-known index revisions and freezes relative changes with quote provenance", async () => {
    const { buildMarketContext } = await import("../src/lib/market-data/context");
    const index = await db.instrument.create({ data: { exchange: "NSE", symbol: "INDEX", name: "Synthetic index", kind: "index", inUniverse: true } });
    const equity = await db.instrument.create({ data: { exchange: "NSE", symbol: "EXAMPLE", name: "Synthetic stock", inUniverse: true, benchmarkId: index.id } });
    const quote = async (time: string, knownAt: string, price: string, hash: string) => db.marketSnapshotRecord.create({ data: { instrumentId: index.id, provider: "synthetic", providerSymbol: "INDEX", retrievedAt: new Date(time), recordedAt: new Date(knownAt), quoteTime: new Date(time), quotePrice: price, quoteFreshness: "recent", quoteAgeSeconds: 0, quoteDelayStatus: "unknown", contentHash: hash, skippedBars: 0, requestedDays: 1 } });
    const reference = await quote("2026-11-04T03:59:30Z", "2026-11-04T03:59:31Z", "100", "baseline");
    const observed = await quote("2026-11-04T04:04:30Z", "2026-11-04T04:04:31Z", "101", "observed");
    await quote("2026-11-04T04:05:00Z", "2026-11-04T04:10:00Z", "120", "future-known");
    const calendar = parseCalendar({ source: "synthetic", coverageStart: "2026-11-01", coverageEnd: "2026-11-30", holidays: [], specialSessions: [] });
    const context = await buildMarketContext(db, calendar, equity, "synthetic", new Date("2026-11-04T04:00:00Z"), new Date("2026-11-04T04:05:00Z"), "2", new Date("2026-11-04T04:05:01Z"));
    expect(context.benchmark).toMatchObject({ changePct: "1.00000000", excessChangePercentagePoints: "1.00000000", snapshotIds: [reference.id, observed.id] });
    expect(context.sector.status).toBe("unavailable");
    expect(context.usualVolatility.status).toBe("unavailable");
  });
});

describe("persistent provider throttling", () => {
  it("honors a server cooldown across wrapper instances without another request", async () => {
    const { rateLimitedFetch } = await import("../src/lib/network/rate-limit");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("rate limited", { status: 429, headers: { "retry-after": "3600" } }));
    expect((await rateLimitedFetch(db, fetcher)("https://synthetic.example.com/feed")).status).toBe(429);
    await expect(rateLimitedFetch(db, fetcher)("https://synthetic.example.com/feed")).rejects.toThrow("PROVIDER_COOLDOWN");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not start a provider request when cancellation is already requested", async () => {
    const { rateLimitedFetch } = await import("../src/lib/network/rate-limit");
    const abort = new AbortController(); abort.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(rateLimitedFetch(db, fetcher)("https://synthetic.example.com/feed", { signal: abort.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not record a successful collection pipeline with no enabled sources", async () => {
    const { collectEnabledSources } = await import("../src/lib/announcements/sources");
    await db.feedSource.updateMany({ data: { enabled: false } });
    await expect(collectEnabledSources(db)).rejects.toMatchObject({ code: "source_configuration_required" });
    expect(await db.feedItem.count()).toBe(0);
  });
});

describe("historical universe provenance", () => {
  it("does not use a later membership import or today's benchmark for an older reference", async () => {
    const { historicalBenchmark } = await import("../src/lib/research/followups");
    const old = await db.instrument.create({ data: { exchange: "NSE", symbol: "OLDINDEX", name: "Old index", kind: "index" } });
    const newer = await db.instrument.create({ data: { exchange: "NSE", symbol: "NEWINDEX", name: "New index", kind: "index" } });
    const instrument = await db.instrument.create({ data: { exchange: "NSE", symbol: "EXAMPLE", name: "Example", benchmarkId: newer.id } });
    await db.universeImport.create({ data: { source: "Synthetic known membership", effectiveDate: new Date("2026-11-01"), importedAt: new Date("2026-11-02T00:00:00Z"), contentHash: "known", members: [{ symbol: "EXAMPLE", benchmark: "OLDINDEX" }] } });
    await db.universeImport.create({ data: { source: "Synthetic later import", effectiveDate: new Date("2026-11-03"), importedAt: new Date("2026-11-06T00:00:00Z"), contentHash: "later", members: [{ symbol: "EXAMPLE", benchmark: "NEWINDEX" }] } });
    const reference = new Date("2026-11-04T04:00:00Z");
    expect(await historicalBenchmark(db, instrument.id, reference, reference)).toMatchObject({ benchmarkId: old.id, mappingStatus: "historical_membership_mapping" });
    expect(await historicalBenchmark(db, instrument.id, new Date("2026-11-01T04:00:00Z"), new Date("2026-11-01T04:00:00Z"))).toMatchObject({ benchmarkId: null, mappingStatus: "historical_mapping_unavailable" });
  });
});

describe("fallback research attribution", () => {
  it("persists the successful fallback provider and skips an identical completed routed request", async () => {
    const { withFallback } = await import("../src/lib/research/provider");
    await seedStarterUniverse(db);
    await storeAnnouncements(db, [{ sourceId: "fallback-fixture", title: "TCS - Financial Results", url: "https://example.com/results", description: "Synthetic financial results", publishedAt: null }]);
    await matchStoredAnnouncements(db); await filterStoredAnnouncements(db);
    const primary = vi.fn<ResearchProvider["analyze"]>().mockRejectedValue(new ResearchError("provider_http_error", 429));
    const fallback = vi.fn<ResearchProvider["analyze"]>().mockResolvedValue({ assessment: { classification: "WATCH", summary: "Synthetic", significance: "Read original", risks: ["Unverified"], uncertainties: ["Missing facts"], evidenceIds: ["announcement"] }, inputTokens: 10, outputTokens: 20 });
    const provider = withFallback({ name: "groq", model: "primary-test", analyze: primary }, { name: "gemini", model: "fallback-test", analyze: fallback });
    expect((await analyzeStoredAnnouncements(db, provider, 1)).analyzed).toBe(1);
    expect(await db.feedResearch.findFirstOrThrow()).toMatchObject({ provider: "gemini", model: "fallback-test", inputTokens: 10 });
    expect((await analyzeStoredAnnouncements(db, provider, 1)).attempted).toBe(0);
    expect(primary).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
  });
});


describe("durable daily AI allowance", () => {
  const input = { stock: { exchange: "NSE", symbol: "TEST", name: "Synthetic" }, announcement: { title: "Synthetic disclosure", description: null, url: "https://example.com/test", publishedAt: null, discoveredAt: "2026-11-05T00:00:00Z" }, relevance: { status: "review", reason: null, ruleVersion: "test" }, contentTruncated: false };
  const result = { assessment: { classification: "WATCH" as const, summary: "Fixture only", significance: "Unknown", risks: ["Unknown"], uncertainties: ["Unverified"], evidenceIds: ["announcement"] }, inputTokens: 1, outputTokens: 1 };
  function provider(analyze = vi.fn<ResearchProvider["analyze"]>().mockResolvedValue(result)): ResearchProvider {
    return { name: "fixture", model: "fixture-model", analyze };
  }
  it("bounds concurrent requests using durable reservations", async () => {
    const analyze = vi.fn<ResearchProvider["analyze"]>().mockResolvedValue(result);
    const limits = { assessments: 3, attempts: 20 };
    const limited = withDailyAllowance(db, provider(analyze), limits);
    const responses = await Promise.allSettled(Array.from({ length: 12 }, () => limited.analyze(input)));
    expect(responses.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(await getDailyAllowance(db, limits)).toMatchObject({ success: 3, pending: 0, failed: 0, attempts: 3, remaining: 0 });
  });
  it("counts failed attempts without consuming all successful-response capacity", async () => {
    const analyze = vi.fn<ResearchProvider["analyze"]>().mockRejectedValueOnce(new ResearchError("provider_http_error", 503)).mockResolvedValue(result);
    const limits = { assessments: 1, attempts: 3 };
    const limited = withDailyAllowance(db, provider(analyze), limits);
    await expect(limited.analyze(input)).rejects.toMatchObject({ code: "provider_http_error" });
    await expect(limited.analyze(input)).resolves.toMatchObject(result);
    await expect(limited.analyze(input)).rejects.toMatchObject({ code: "daily_ai_assessment_limit" });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(await getDailyAllowance(db, limits)).toMatchObject({ success: 1, failed: 1, attempts: 2, remaining: 0 });
  });
  it("does not let fallback bypass the shared attempt limit", async () => {
    const primary = vi.fn<ResearchProvider["analyze"]>().mockRejectedValue(new ResearchError("provider_http_error", 429));
    const fallback = vi.fn<ResearchProvider["analyze"]>().mockResolvedValue(result);
    const limits = { assessments: 2, attempts: 1 };
    const limited = withFallback(withDailyAllowance(db, provider(primary), limits), withDailyAllowance(db, { ...provider(fallback), name: "fallback" }, limits));
    await expect(limited.analyze(input)).rejects.toMatchObject({ code: "daily_ai_attempt_limit" });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(await getDailyAllowance(db, limits)).toMatchObject({ success: 0, failed: 1, attempts: 1 });
  });
  it("keeps uncertain crash reservations counted and scopes them to their IST day", async () => {
    const limits = { assessments: 1, attempts: 2 };
    const held = await reserveAiRequest(db, "fixture", "fixture-model", limits);
    await expect(reserveAiRequest(db, "fixture", "fixture-model", limits)).rejects.toMatchObject({ code: "daily_ai_assessment_limit" });
    const usage = await getDailyAllowance(db, limits);
    expect(usage).toMatchObject({ success: 0, pending: 1, remaining: 0 });
    const yesterday = new Date(Date.parse(`${usage.day}T00:00:00Z`) - 86400000);
    await db.researchAllowanceUse.update({ where: { id: held.id }, data: { day: yesterday } });
    expect(await getDailyAllowance(db, limits)).toMatchObject({ pending: 0, attempts: 0, remaining: 1 });
    await expect(reserveAiRequest(db, "fixture", "fixture-model", limits)).resolves.toHaveProperty("id");
  });
  it("defers announcement AI at zero allowance while retaining the source", async () => {
    const instrument = await db.instrument.create({ data: { exchange: "NSE", symbol: "BUDGET", name: "Budget Fixture", inUniverse: true } });
    await db.feedItem.create({ data: { source: NSE_SOURCE, sourceId: "budget-deferred", title: "Budget Fixture - Results", url: "https://example.com/budget", instrumentId: instrument.id, matchStatus: "matched", matchCheckedAt: new Date(), relevanceStatus: "review", relevanceReason: "fixture", relevanceRuleVersion: RELEVANCE_RULE_VERSION, relevanceCheckedAt: new Date() } });
    const analyze = vi.fn<ResearchProvider["analyze"]>().mockResolvedValue(result);
    const limited = withDailyAllowance(db, provider(analyze), { assessments: 0, attempts: 0 });
    expect(await analyzeStoredAnnouncements(db, limited, 1)).toMatchObject({ analyzed: 0, failed: 0, attempted: 0, deferred: true, allowanceReason: "daily_ai_attempt_limit" });
    expect(analyze).not.toHaveBeenCalled();
    expect(await db.feedItem.count()).toBe(1);
    expect(await db.researchAllowanceUse.count()).toBe(0);
  });
});
