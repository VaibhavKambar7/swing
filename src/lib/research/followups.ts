import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { CalendarError, getMarketDay, getMarketState, marketDate, type MarketCalendar } from "../market/calendar";
export const FOLLOWUP_VERSION = "first-observation-to-future-session-close-v1";
export const followUpPayload = z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict();
const MINUTE = 60000;
const Calc = Prisma.Decimal.clone({ precision: 60 });
function referenceWindow(calendar: MarketCalendar, createdAt: Date) {
  const state = getMarketState(calendar, createdAt);
  if (state.status === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  const session = state.currentSession ?? state.nextSession;
  if (!session) throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  const start = new Date(Math.max(createdAt.getTime(), Date.parse(session.opensAt)));
  const end = new Date(Math.min(start.getTime() + 15 * MINUTE, Date.parse(session.closesAt)));
  return { start, end };
}
function targetWindow(calendar: MarketCalendar, referenceAt: Date, horizon: number) {
  let date = marketDate(referenceAt), remaining = horizon;
  for (let i = 0; i < 3660; i++) {
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const day = getMarketDay(calendar, date);
    if (day.kind === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
    if (!day.sessions.length || --remaining > 0) continue;
    const session = day.sessions.at(-1)!;
    const close = new Date(`${date}T${session.close}:00+05:30`);
    return { close, start: new Date(Math.max(Date.parse(`${date}T${session.open}:00+05:30`), close.getTime() - 15 * MINUTE)), end: new Date(close.getTime() + 5 * MINUTE) };
  }
  throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
}
export async function updateResearchFollowUps(db: PrismaClient, calendar: MarketCalendar, limit = 25, at = new Date(), signal?: AbortSignal) {
  followUpPayload.parse({ limit });
  if (!Number.isFinite(at.getTime())) throw new CalendarError("INVALID_INSTANT");
  signal?.throwIfAborted();
  const [filings, movements] = await Promise.all([
    db.feedResearch.findMany({ where: { classification: { in: ["INVESTIGATE", "WATCH"] }, followUps: { none: { methodologyVersion: FOLLOWUP_VERSION } }, createdAt: { lte: at } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } }),
    db.analysis.findMany({ where: { signal: { origin: "movement" }, OR: [{ assessment: { path: ["classification"], equals: "INVESTIGATE" } }, { assessment: { path: ["classification"], equals: "WATCH" } }], followUps: { none: { methodologyVersion: FOLLOWUP_VERSION } }, createdAt: { lte: at } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } }),
  ]);
  const seeded = await db.researchFollowUp.createMany({ data: [
    ...filings.flatMap((item) => [1, 5, 20].map((horizonSessions) => ({ feedResearchId: item.id, horizonSessions, methodologyVersion: FOLLOWUP_VERSION }))),
    ...movements.flatMap((item) => [1, 5, 20].map((horizonSessions) => ({ analysisId: item.id, horizonSessions, methodologyVersion: FOLLOWUP_VERSION }))),
  ], skipDuplicates: true });
  const pending = await db.researchFollowUp.findMany({ where: { status: "pending", methodologyVersion: FOLLOWUP_VERSION }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
  const counts = { seeded: seeded.count, pending: 0, measured: 0, unavailable: 0 };
  for (const { id } of pending) {
    signal?.throwIfAborted();
    const status = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM research_followups WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.researchFollowUp.findUniqueOrThrow({ where: { id }, include: {
        referenceSnapshot: true, feedResearch: { include: { feedItem: { select: { instrumentId: true } } } },
        analysis: { include: { signal: { select: { instrumentId: true } } } },
      } });
      if (row.status !== "pending") return null;
      const save = (status: "pending" | "unavailable", reason: string) => tx.researchFollowUp.update({ where: { id }, data: { status, reason, updatedAt: at } }).then(() => status);
      const instrumentId = row.feedResearch?.feedItem.instrumentId ?? row.analysis?.signal.instrumentId;
      const publishedAt = row.feedResearch?.createdAt ?? row.analysis!.createdAt;
      if (!instrumentId) return save("unavailable", "INSTRUMENT_UNAVAILABLE");
      try {
        let reference = row.referenceSnapshot;
        if (!reference) {
          const window = referenceWindow(calendar, publishedAt);
          // Requiring retrieval AND recording by the reference deadline prevents
          // later historical imports from inventing a contemporaneous baseline.
          const deadline = new Date(Math.min(at.getTime(), window.end.getTime()));
          reference = await tx.marketSnapshotRecord.findFirst({ where: { instrumentId, provider: "yahoo-experimental", currency: "INR",
            quotePrice: { not: null }, quoteFreshness: "recent", quoteAgeSeconds: { gte: 0, lte: 300 },
            quoteTime: { gte: window.start, lte: deadline }, retrievedAt: { gte: window.start, lte: deadline }, recordedAt: { lte: deadline, gte: window.start },
          }, orderBy: [{ quoteTime: "asc" }, { retrievedAt: "asc" }, { id: "asc" }] });
          if (!reference) return save(at < window.end ? "pending" : "unavailable", at < window.end ? "AWAITING_REFERENCE" : "REFERENCE_WINDOW_MISSING");
          await tx.researchFollowUp.update({ where: { id }, data: { referenceSnapshotId: reference.id, referenceAt: reference.quoteTime, referencePrice: reference.quotePrice, updatedAt: at } });
        }
        const window = targetWindow(calendar, reference.quoteTime!, row.horizonSessions);
        await tx.researchFollowUp.update({ where: { id }, data: { dueAt: window.end, updatedAt: at } });
        if (at < window.end) return save("pending", "HORIZON_NOT_DUE");
        const observed = await tx.marketSnapshotRecord.findFirst({ where: { instrumentId, provider: reference.provider, providerSymbol: reference.providerSymbol, currency: reference.currency,
          quotePrice: { not: null }, quoteFreshness: "recent", quoteAgeSeconds: { gte: 0, lte: 300 },
          quoteTime: { gte: window.start, lte: window.close }, retrievedAt: { gte: window.start, lte: window.end }, recordedAt: { gte: window.start, lte: window.end },
        }, orderBy: [{ quoteTime: "desc" }, { retrievedAt: "asc" }, { id: "asc" }] });
        if (!observed) return save("unavailable", "HORIZON_OBSERVATION_MISSING");
        const base = new Calc(reference.quotePrice!.toString()), price = new Calc(observed.quotePrice!.toString());
        if (base.lte(0) || price.lte(0) || !base.isFinite() || !price.isFinite()) return save("unavailable", "INVALID_OBSERVATION_PRICE");
        const change = price.minus(base).div(base).mul(100).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
        if (change.abs().gte("10000000000")) return save("unavailable", "CHANGE_OUT_OF_RANGE");
        await tx.researchFollowUp.update({ where: { id }, data: { status: "measured", reason: "UNVERIFIED_SOURCE_PRICE_CHANGE", observedSnapshotId: observed.id, observedAt: observed.quoteTime, observedPrice: observed.quotePrice, changePct: change.toFixed(8), updatedAt: at } });
        return "measured" as const;
      } catch (error) {
        if (error instanceof CalendarError) return save("pending", error.code);
        throw error;
      }
    });
    if (status) counts[status]++;
  }
  return counts;
}
export async function scheduleResearchFollowUps(db: PrismaClient, at = new Date()) {
  const slot = new Date(Math.floor(at.getTime() / 3600000) * 3600000).toISOString();
  const result = await db.job.createMany({ data: [{ kind: "research.followups", dedupeKey: `followups:${FOLLOWUP_VERSION}:${slot}`, payload: { limit: 25 }, runAfter: at }], skipDuplicates: true });
  return { status: result.count ? "enqueued" : "already_scheduled" };
}
