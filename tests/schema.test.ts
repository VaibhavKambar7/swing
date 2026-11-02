import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { storeAnnouncements } from "../src/lib/announcements/ingest";

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
