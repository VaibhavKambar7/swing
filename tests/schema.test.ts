import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { filterStoredAnnouncements, RELEVANCE_RULE_VERSION } from "../src/lib/announcements/filter";
import { storeAnnouncements } from "../src/lib/announcements/ingest";
import { matchStoredAnnouncements } from "../src/lib/announcements/match";
import { seedStarterUniverse } from "../src/lib/instruments/starter-universe";
import { NSE_SOURCE, parseAnnouncements } from "../src/lib/announcements/rss";

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
  await db.$executeRaw`TRUNCATE feed_items, instruments, announcements, signals, signal_evidence,
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
