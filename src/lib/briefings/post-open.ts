import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient, type MarketSnapshotRecord } from "../../generated/prisma/client";
import { CalendarError, getMarketDay, marketDate, type MarketCalendar } from "../market/calendar";
import { BriefingError, MORNING_VERSION } from "./morning";

export const POST_OPEN_VERSION = "post-open-v1";
const Calc = Prisma.Decimal.clone({ precision: 60 });
const watchlistSchema = z.object({ watchlist: z.array(z.object({ symbol: z.string().min(1).max(30), feedItemId: z.string().uuid() })).max(20) });

export function postOpenWindow(calendar: MarketCalendar, date: string) {
  const day = getMarketDay(calendar, date);
  if (day.kind === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  if (!day.sessions.length) throw new BriefingError("NOT_A_TRADING_DAY");
  const opensAt = new Date(`${date}T${day.sessions[0].open}:00+05:30`);
  const dueAt = new Date(opensAt.getTime() + 300000);
  const endsAt = new Date(Math.min(opensAt.getTime() + 900000, Date.parse(`${date}T${day.sessions[0].close}:00+05:30`)));
  if (endsAt <= dueAt) throw new BriefingError("SESSION_TOO_SHORT_FOR_REASSESSMENT");
  return { opensAt, dueAt, endsAt };
}

export function planPostOpen(calendar: MarketCalendar, at = new Date()) {
  const date = marketDate(at);
  let window;
  try { window = postOpenWindow(calendar, date); }
  catch (error) { if (error instanceof BriefingError) return { status: "skipped" as const, reason: error.code }; throw error; }
  if (at < window.dueAt || at >= window.endsAt) return { status: "skipped" as const, reason: "OUTSIDE_REASSESSMENT_WINDOW" };
  const slot = Math.floor((at.getTime() - window.dueAt.getTime()) / 60000);
  return { status: "due" as const, sessionDate: date, dedupeKey: `post-open:${date}:${POST_OPEN_VERSION}:${slot}`, runAfter: new Date(window.dueAt.getTime() + slot * 60000) };
}

export async function schedulePostOpen(db: PrismaClient, calendar: MarketCalendar, at = new Date()) {
  const plan = planPostOpen(calendar, at);
  if (plan.status !== "due") return plan;
  const written = await db.job.createMany({ data: [{ kind: "briefings.reassess", dedupeKey: plan.dedupeKey, payload: { sessionDate: plan.sessionDate }, runAfter: plan.runAfter }], skipDuplicates: true });
  return { status: written.count ? "enqueued" : "already_scheduled", sessionDate: plan.sessionDate };
}

type Quote = Pick<MarketSnapshotRecord, "id" | "instrumentId" | "provider" | "providerSymbol" | "currency" | "quoteTime" | "quotePrice" | "quoteFreshness" | "retrievedAt">;
export function evaluatePostOpen(current: Quote | null, opening: Quote | null, window: ReturnType<typeof postOpenWindow>, at: Date) {
  const pending = (reason: string) => ({ status: "PENDING_DATA" as const, reason, changeSinceObservedOpenPct: null as string | null });
  if (!Number.isFinite(at.getTime()) || at < window.dueAt || at >= window.endsAt) return pending("OUTSIDE_REASSESSMENT_WINDOW");
  if (!current?.quoteTime || !current.quotePrice) return pending("CURRENT_QUOTE_MISSING");
  const age = at.getTime() - current.quoteTime.getTime();
  if (age < 0 || current.retrievedAt > at || current.retrievedAt < current.quoteTime || current.quoteFreshness === "clock_skew") return pending("FUTURE_OR_SKEWED_QUOTE");
  if (age > 120000) return pending("CURRENT_QUOTE_STALE");
  if (current.quoteTime.getTime() < window.dueAt.getTime() - 60000) return pending("QUOTE_BEFORE_REASSESSMENT");
  if (!opening?.quoteTime || !opening.quotePrice) return pending("OPENING_OBSERVATION_MISSING");
  if (opening.instrumentId !== current.instrumentId || opening.provider !== current.provider || opening.providerSymbol !== current.providerSymbol || opening.currency !== current.currency || current.currency !== "INR") return pending("INCOMPATIBLE_OBSERVATIONS");
  if (opening.quoteTime < window.opensAt || opening.quoteTime.getTime() > window.opensAt.getTime() + 60000 || opening.retrievedAt > at || opening.retrievedAt < opening.quoteTime || opening.retrievedAt.getTime() - opening.quoteTime.getTime() > 120000 || opening.quoteFreshness !== "recent") return pending("OPENING_OBSERVATION_UNRELIABLE");
  const price = new Calc(current.quotePrice.toString()), base = new Calc(opening.quotePrice.toString());
  if (!price.isFinite() || !base.isFinite() || price.lte(0) || base.lte(0)) return pending("INVALID_PRICES");
  const change = price.minus(base).div(base).mul(100);
  if (change.abs().gte("10000000000")) return pending("CHANGE_OUT_OF_RANGE");
  return { status: change.abs().gte(5) ? "CAUTION" as const : "WATCH" as const,
    reason: change.gte(5) ? "RAPID_POST_OPEN_RISE" : change.lte(-5) ? "RAPID_POST_OPEN_FALL" : "RESEARCH_REVIEW_REQUIRED",
    changeSinceObservedOpenPct: change.toFixed(8) };
}

export async function reassessMorningWatchlist(db: PrismaClient, calendar: MarketCalendar, date = marketDate(new Date()), at = new Date()) {
  const window = postOpenWindow(calendar, date);
  if (!Number.isFinite(at.getTime()) || at < window.dueAt) throw new BriefingError("BRIEFING_NOT_DUE");
  if (at >= window.endsAt) throw new BriefingError("REASSESSMENT_WINDOW_CLOSED");
  const sessionDate = new Date(`${date}T00:00:00Z`);
  const morning = await db.dailyBriefing.findUnique({ where: { kind_sessionDate_reportVersion: { kind: "morning", sessionDate, reportVersion: MORNING_VERSION } } });
  if (!morning) throw new BriefingError("MORNING_BRIEFING_REQUIRED");
  if (morning.generatedAt >= window.opensAt || morning.cutoffAt >= window.opensAt) throw new BriefingError("MORNING_REPORT_NOT_PREMARKET");
  const parsed = watchlistSchema.safeParse(morning.content);
  if (!parsed.success) throw new BriefingError("INVALID_MORNING_WATCHLIST");
  const symbols = [...new Set(parsed.data.watchlist.map((item) => item.symbol))];
  const stocks = await db.instrument.findMany({ where: { exchange: "NSE", symbol: { in: symbols }, kind: "equity", active: true, inUniverse: true }, orderBy: { symbol: "asc" } });
  const assessments = [];
  let inserted = 0;
  for (const stock of stocks) {
    const [current, opening] = await Promise.all([
      db.marketSnapshotRecord.findFirst({ where: { instrumentId: stock.id, provider: "yahoo-experimental", recordedAt: { lte: at } }, orderBy: [{ retrievedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }] }),
      db.marketSnapshotRecord.findFirst({ where: { instrumentId: stock.id, provider: "yahoo-experimental", recordedAt: { lte: at }, retrievedAt: { lte: at }, quoteAgeSeconds: { gte: 0, lte: 120 }, quoteTime: { gte: window.opensAt, lte: new Date(window.opensAt.getTime() + 60000) }, quotePrice: { not: null }, quoteFreshness: "recent" }, orderBy: [{ quoteTime: "asc" }, { retrievedAt: "asc" }, { id: "asc" }] }),
    ]);
    const decision = evaluatePostOpen(current, opening, window, at);
    const semantic = { morningBriefingId: morning.id, symbol: stock.symbol, currentSnapshotId: current?.id ?? null, openingSnapshotId: opening?.id ?? null,
      sessionOpen: window.opensAt.toISOString(), dueAt: window.dueAt.toISOString(), windowEndsAt: window.endsAt.toISOString(), ...decision };
    const hash = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
    const identity = { morningBriefingId: morning.id, instrumentId: stock.id, rulesVersion: POST_OPEN_VERSION, inputHash: hash };
    const content = { ...semantic, assessedAt: at.toISOString(), quoteTime: current?.quoteTime?.toISOString() ?? null, retrievedAt: current?.retrievedAt.toISOString() ?? null,
      quoteAgeSeconds: current?.quoteTime ? (at.getTime() - current.quoteTime.getTime()) / 1000 : null,
      openingQuoteTime: opening?.quoteTime?.toISOString() ?? null, provider: current?.provider ?? null,
      price: current?.quotePrice?.toString() ?? null, observedOpeningPrice: opening?.quotePrice?.toString() ?? null,
      overnightGapPct: null, providerDelay: "unknown", action: "research_only",
      limitations: ["Opening observation is not a verified exchange opening price.", "No verified previous close, valuation, liquidity or risk/entry plan is available.", "This is a research reassessment, not a buy/sell instruction."] };
    const written = await db.postOpenAssessment.createMany({ data: [{ ...identity, sessionDate, status: decision.status, reason: decision.reason, assessedAt: at, content }], skipDuplicates: true });
    inserted += written.count;
    const stored = await db.postOpenAssessment.findUniqueOrThrow({ where: { morningBriefingId_instrumentId_rulesVersion_inputHash: identity } });
    assessments.push({ id: stored.id, symbol: stock.symbol, status: stored.status, reason: stored.reason, assessedAt: stored.assessedAt, content: stored.content });
  }
  return { sessionDate: date, evaluatedAt: at.toISOString(), morningBriefingId: morning.id, inserted,
    watchlistEmpty: symbols.length === 0, pending: assessments.filter((entry) => entry.status === "PENDING_DATA").length,
    watch: assessments.filter((entry) => entry.status === "WATCH").length, caution: assessments.filter((entry) => entry.status === "CAUTION").length,
    skippedSymbols: symbols.filter((symbol) => !stocks.some((stock) => stock.symbol === symbol)), assessments };
}
