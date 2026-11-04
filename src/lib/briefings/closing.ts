import type { PrismaClient } from "../../generated/prisma/client";
import { CalendarError, getMarketDay, getMarketState, marketDate, type MarketCalendar } from "../market/calendar";
import { BriefingError } from "./morning";
import { RELEVANCE_RULE_VERSION } from "../announcements/filter";
import { RESEARCH_PROMPT_VERSION } from "../research/schema";
import { MOVEMENT_RESEARCH_VERSION } from "../research/movement";
import { MOVEMENT_VERSION } from "../market-data/detect";

export const CLOSING_VERSION = "closing-v1";

export function closingWindow(calendar: MarketCalendar, date: string) {
  const day = getMarketDay(calendar, date);
  if (day.kind === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  if (!day.sessions.length) throw new BriefingError("NOT_A_TRADING_DAY");
  const sessionOpen = new Date(`${date}T${day.sessions[0].open}:00+05:30`);
  const sessionClose = new Date(`${date}T${day.sessions[day.sessions.length - 1].close}:00+05:30`);
  const lastSessionOpen = new Date(`${date}T${day.sessions[day.sessions.length - 1].open}:00+05:30`);
  const cutoffAt = new Date(Math.max(Date.parse(`${date}T15:45:00+05:30`), sessionClose.getTime() + 15 * 60000));
  return { sessionOpen, sessionClose, lastSessionOpen, cutoffAt, windowStart: new Date(`${date}T00:00:00+05:30`) };
}

export function planClosingBriefing(calendar: MarketCalendar, at = new Date()) {
  const today = marketDate(at);
  if (getMarketDay(calendar, today).kind === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  for (const date of [today, yesterday]) {
    try {
      const window = closingWindow(calendar, date);
      // The previous date matters only for a late session whose cutoff crosses midnight.
      if (marketDate(window.cutoffAt) === today && at >= window.cutoffAt) return { status: "due" as const, sessionDate: date, cutoffAt: window.cutoffAt, dedupeKey: `briefing:closing:${date}:${CLOSING_VERSION}` };
    } catch (error) {
      if (error instanceof BriefingError || (date === yesterday && error instanceof CalendarError)) continue;
      throw error;
    }
  }
  return { status: "skipped" as const, reason: "NOT_DUE_OR_NONTRADING", sessionDate: today };
}

export async function scheduleClosingBriefing(db: PrismaClient, calendar: MarketCalendar, at = new Date()) {
  const plan = planClosingBriefing(calendar, at);
  if (plan.status !== "due") return plan;
  const created = await db.job.createMany({ data: [{ kind: "briefings.closing", dedupeKey: plan.dedupeKey, payload: { sessionDate: plan.sessionDate }, runAfter: plan.cutoffAt }], skipDuplicates: true });
  return { status: created.count ? "enqueued" : "already_scheduled", sessionDate: plan.sessionDate, dedupeKey: plan.dedupeKey };
}

function text(value: string) { return value.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&").slice(0, 2000); }
function ist(value: Date) { return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(value)} IST`; }
function url(value: string) {
  const parsed = URL.parse(value);
  return parsed && ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
}

export async function generateClosingBriefing(db: PrismaClient, calendar: MarketCalendar, date = marketDate(new Date()), at = new Date()) {
  const window = closingWindow(calendar, date);
  if (!Number.isFinite(at.getTime()) || at < window.cutoffAt) throw new BriefingError("BRIEFING_NOT_DUE");
  const identity = { kind: "closing", sessionDate: new Date(`${date}T00:00:00Z`), reportVersion: CLOSING_VERSION };
  return db.$transaction(async (tx) => {
    const prior = await tx.dailyBriefing.findUnique({ where: { kind_sessionDate_reportVersion: identity } });
    if (prior) return { status: "existing", report: prior };
    const universe = { active: true, inUniverse: true, exchange: "NSE", kind: "equity" as const };
    const filingWhere = { matchStatus: "matched" as const, instrument: universe,
      matchCheckedAt: { lte: window.cutoffAt }, relevanceCheckedAt: { lte: window.cutoffAt },
      relevanceStatus: { in: ["keep" as const, "review" as const] }, relevanceRuleVersion: RELEVANCE_RULE_VERSION,
      discoveredAt: { lte: window.cutoffAt }, publishedAt: { gte: window.windowStart, lte: window.cutoffAt } };
    const [stocks, universeCount, filings, filingCount, signals, signalCount] = await Promise.all([
      tx.instrument.findMany({ where: universe, orderBy: { symbol: "asc" }, take: 100, select: { symbol: true, marketSnapshots: {
        where: { provider: "yahoo-experimental", retrievedAt: { lte: window.cutoffAt }, recordedAt: { lte: window.cutoffAt } },
        orderBy: [{ retrievedAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }], take: 1,
        include: { candles: { where: { sessionDate: identity.sessionDate }, take: 1 } },
      } } }),
      tx.instrument.count({ where: universe }),
      tx.feedItem.findMany({ where: filingWhere, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], take: 20,
        include: { instrument: true, research: { where: { promptVersion: RESEARCH_PROMPT_VERSION, createdAt: { lte: window.cutoffAt } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 1 } } }),
      tx.feedItem.count({ where: filingWhere }),
      tx.signal.findMany({ where: { origin: "movement", detectorVersion: MOVEMENT_VERSION, instrument: universe,
        observedAt: { gte: window.sessionOpen, lt: window.sessionClose }, createdAt: { lte: window.cutoffAt } },
        orderBy: [{ observedAt: "desc" }, { id: "asc" }], take: 50,
        include: { instrument: true, analyses: { where: { promptVersion: MOVEMENT_RESEARCH_VERSION, createdAt: { lte: window.cutoffAt } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 1 } } }),
      tx.signal.count({ where: { origin: "movement", detectorVersion: MOVEMENT_VERSION, instrument: universe, observedAt: { gte: window.sessionOpen, lt: window.sessionClose }, createdAt: { lte: window.cutoffAt } } }),
    ]);
    const observations = stocks.map((stock) => {
      const snapshot = stock.marketSnapshots[0];
      const quoteTime = snapshot?.quoteTime;
      const nearClose = !!snapshot?.quotePrice && !!quoteTime && snapshot.quoteFreshness !== "clock_skew" && quoteTime.getTime() >= Math.max(window.sessionClose.getTime() - 300000, window.lastSessionOpen.getTime()) && quoteTime <= window.sessionClose;
      return { symbol: stock.symbol, snapshotId: snapshot?.id ?? null,
        status: nearClose ? "unverified_near_close_observation" : "no_suitable_close_observation",
        price: nearClose ? snapshot!.quotePrice!.toString() : null, sourceTime: quoteTime?.toISOString() ?? null,
        retrievedAt: snapshot?.retrievedAt.toISOString() ?? null,
        ageAtCutoffSeconds: quoteTime ? (window.cutoffAt.getTime() - quoteTime.getTime()) / 1000 : null,
        delayStatus: snapshot?.quoteDelayStatus ?? "unknown",
        reportedDailyVolume: snapshot?.candles[0] && snapshot.candles[0].sourceTime <= window.cutoffAt ? snapshot.candles[0].volume?.toString() ?? null : null,
        volumeCompletion: snapshot?.candles[0]?.completion ?? "unavailable", verifiedClosingPrice: false };
    });
    const daySessions = getMarketDay(calendar, date).sessions;
    const movements = signals.filter((entry) => daySessions.some((session) => entry.observedAt >= new Date(`${date}T${session.open}:00+05:30`) && entry.observedAt < new Date(`${date}T${session.close}:00+05:30`))).map((entry) => ({
      signalId: entry.id, symbol: entry.instrument.symbol, observedAt: entry.observedAt.toISOString(),
      windowStart: entry.windowStart?.toISOString() ?? null, priceChangePct: entry.priceChangePct?.toString() ?? null,
      methodology: "recorded 5–6 minute trigger, not a daily return",
      research: entry.analyses[0] ? { analysisId: entry.analyses[0].id, summary: entry.analyses[0].summary, risks: entry.analyses[0].risks, uncertainties: entry.analyses[0].uncertainties, catalystVerified: false } : null,
    }));
    const notices = filings.filter((entry) => url(entry.url)).map((entry) => ({ feedItemId: entry.id, symbol: entry.instrument!.symbol, title: entry.title.slice(0, 1000), url: url(entry.url)!, publishedAt: entry.publishedAt!.toISOString(),
      classification: entry.research[0]?.classification ?? null, summary: entry.research[0]?.summary ?? null }));
    const content = {
      sessionDate: date, cutoffAt: window.cutoffAt.toISOString(), sessionOpen: window.sessionOpen.toISOString(), sessionClose: window.sessionClose.toISOString(),
      generatedAt: at.toISOString(), status: "preliminary", nextSession: getMarketState(calendar, window.cutoffAt).nextSession,
      coverage: { universeCount, observedStocks: observations.length, suitableCloseObservations: observations.filter((entry) => entry.price !== null).length,
        indices: "unavailable", externalNews: "not_configured", dailyReturnRankings: "unavailable", unusualVolume: "not_computed", closingPrices: "unverified" },
      observations, movements, filings: notices, researchWatchlist: notices.filter((entry) => entry.classification !== "IGNORE"),
      omittedStocks: universeCount - observations.length, omittedFilings: filingCount - notices.length, omittedMovements: signalCount - movements.length,
      limitations: ["Preliminary tracked-stock summary; stored quotes are not verified official closing prices.",
        "Intraday trigger percentages are not daily gainers/losers or investment recommendations.",
        "No verified Nifty/Sensex performance, unusual-volume baseline or external-news feed is available.",
        "Existing AI research is unverified; a nearby filing does not establish the cause of a price move."],
    };
    const markdown = [`# Swing — Market Summary | ${date} | PRELIMINARY`,
      `Session close: ${ist(window.sessionClose)}. Information cutoff: ${ist(window.cutoffAt)}.`,
      `Coverage: inspected ${observations.length} of ${universeCount} tracked stocks; ${content.coverage.suitableCloseObservations} suitable but unverified near-close observations.`,
      "## End-of-session observations (not verified closes)",
      ...observations.map((entry) => `- **${text(entry.symbol)}** — ${entry.price === null ? "No suitable stored near-close quote." : `₹${entry.price}; source timestamp ${ist(new Date(entry.sourceTime!))}; not an official close.`}`),
      "## Recorded intraday movement triggers (not daily returns)",
      ...(movements.length ? movements.map((entry) => `- **${text(entry.symbol)}** — ${entry.priceChangePct ?? "unknown"}% over a recorded 5–6 minute window.${entry.research ? ` Existing AI research: ${text(entry.research.summary)}` : " No pre-cutoff movement research available."}`) : ["No eligible stored movement triggers. This does not establish a quiet market."]),
      "## Company filings and research for the next session",
      ...(notices.length ? notices.map((entry) => `- **${text(entry.symbol)}** — [${text(entry.title)}](${entry.url.replace(/[()\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}) · ${entry.classification ?? "NEEDS REVIEW"}${entry.summary ? `: ${text(entry.summary)}` : ""}`) : ["No eligible stored filings in this day's window."]),
      `Next session: ${content.nextSession ? ist(new Date(content.nextSession.opensAt)) : "unavailable within maintained calendar coverage"}.`,
      "## Coverage gaps", ...content.limitations.map((entry) => `- ${entry}`),
      `- Report limits omitted ${content.omittedStocks} stock(s), ${content.omittedFilings} filing(s), and ${content.omittedMovements} recorded movement(s).`,
    ].join("\n\n");
    const inserted = await tx.dailyBriefing.createMany({ data: [{ ...identity, cutoffAt: window.cutoffAt, windowStart: window.windowStart, generatedAt: at, content, markdown }], skipDuplicates: true });
    const report = await tx.dailyBriefing.findUniqueOrThrow({ where: { kind_sessionDate_reportVersion: identity } });
    return { status: inserted.count ? "generated" : "existing", report };
  });
}
