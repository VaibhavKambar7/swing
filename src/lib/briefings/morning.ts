import type { PrismaClient } from "../../generated/prisma/client";
import { CalendarError, getMarketDay, marketDate, type MarketCalendar } from "../market/calendar";
import { NSE_SOURCE } from "../announcements/rss";
import { RELEVANCE_RULE_VERSION } from "../announcements/filter";
import { RESEARCH_PROMPT_VERSION } from "../research/schema";

export const MORNING_VERSION = "morning-v1";
export class BriefingError extends Error {
  constructor(public readonly code: string) { super(`Morning briefing: ${code}`); }
}

export function morningWindow(calendar: MarketCalendar, date: string) {
  const day = getMarketDay(calendar, date);
  if (day.kind === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  if (!day.sessions.length) throw new BriefingError("NOT_A_TRADING_DAY");
  const cutoffAt = new Date(`${date}T08:45:00+05:30`);
  const opensAt = new Date(`${date}T${day.sessions[0].open}:00+05:30`);
  if (opensAt <= cutoffAt) throw new BriefingError("SESSION_OPENS_BEFORE_BRIEFING");
  const start = Date.parse(`${calendar.coverageStart}T00:00:00Z`);
  for (let time = Date.parse(`${date}T00:00:00Z`) - 86400000; time >= start; time -= 86400000) {
    const previousDate = new Date(time).toISOString().slice(0, 10);
    const previous = getMarketDay(calendar, previousDate);
    if (previous.sessions.length) return { cutoffAt, opensAt, windowStart: new Date(`${previousDate}T${previous.sessions[previous.sessions.length - 1].close}:00+05:30`), windowBasis: "previous_session_close" };
  }
  return { cutoffAt, opensAt, windowStart: new Date(cutoffAt.getTime() - 86400000), windowBasis: "fallback_24h_calendar_incomplete" };
}

export function planMorningBriefing(calendar: MarketCalendar, at = new Date()) {
  const date = marketDate(at);
  let window;
  try { window = morningWindow(calendar, date); }
  catch (error) {
    if (error instanceof BriefingError) return { status: "skipped" as const, reason: error.code, sessionDate: date };
    throw error;
  }
  if (at < window.cutoffAt) return { status: "skipped" as const, reason: "NOT_DUE", sessionDate: date };
  if (at >= window.opensAt) return { status: "skipped" as const, reason: "PREMARKET_WINDOW_CLOSED", sessionDate: date };
  return { status: "due" as const, sessionDate: date, dedupeKey: `briefing:morning:${date}:${MORNING_VERSION}`, cutoffAt: window.cutoffAt };
}

export async function scheduleMorningBriefing(db: PrismaClient, calendar: MarketCalendar, at = new Date()) {
  const plan = planMorningBriefing(calendar, at);
  if (plan.status !== "due") return plan;
  const result = await db.job.createMany({ data: [{ kind: "briefings.morning", dedupeKey: plan.dedupeKey, payload: { sessionDate: plan.sessionDate }, runAfter: plan.cutoffAt }], skipDuplicates: true });
  return { status: result.count ? "enqueued" : "already_scheduled", sessionDate: plan.sessionDate, dedupeKey: plan.dedupeKey };
}

function plain(value: string) { return value.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&").slice(0, 2000); }
function ist(value: Date) { return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(value)} IST`; }
function safeUrl(value: string) {
  const parsed = URL.parse(value);
  return parsed && ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
}

export async function generateMorningBriefing(db: PrismaClient, calendar: MarketCalendar, date = marketDate(new Date()), at = new Date()) {
  const window = morningWindow(calendar, date);
  if (!Number.isFinite(at.getTime()) || at < window.cutoffAt) throw new BriefingError("BRIEFING_NOT_DUE");
  const identity = { kind: "morning", sessionDate: new Date(`${date}T00:00:00Z`), reportVersion: MORNING_VERSION };
  return db.$transaction(async (tx) => {
    const prior = await tx.dailyBriefing.findUnique({ where: { kind_sessionDate_reportVersion: identity } });
    if (prior) return { status: "existing", report: prior };
    const eligible = {
      matchStatus: "matched" as const,
      instrument: { active: true, inUniverse: true, exchange: "NSE", kind: "equity" as const },
      matchCheckedAt: { lte: window.cutoffAt }, relevanceCheckedAt: { lte: window.cutoffAt },
      relevanceStatus: { in: ["keep" as const, "review" as const] }, relevanceRuleVersion: RELEVANCE_RULE_VERSION,
      discoveredAt: { gte: window.windowStart, lte: window.cutoffAt },
    };
    const timed = { ...eligible, publishedAt: { gte: window.windowStart, lte: window.cutoffAt } };
    const [filings, total, undatedCount, universeCount, lastPipeline] = await Promise.all([
      tx.feedItem.findMany({ where: timed, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], take: 50,
        include: { instrument: true, research: { where: { createdAt: { lte: window.cutoffAt }, promptVersion: RESEARCH_PROMPT_VERSION }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 1 } } }),
      tx.feedItem.count({ where: timed }),
      tx.feedItem.count({ where: { ...eligible, publishedAt: null } }),
      tx.instrument.count({ where: { exchange: "NSE", kind: "equity", active: true, inUniverse: true } }),
      tx.job.findFirst({ where: { kind: "announcements.pipeline", status: "succeeded", completedAt: { lte: window.cutoffAt } }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
    ]);
    const rank = (classification: string | null) => classification === "INVESTIGATE" ? 0 : classification === "WATCH" ? 1 : classification === "IGNORE" ? 3 : 2;
    const candidates = filings.filter((entry) => safeUrl(entry.url)).map((entry) => {
      const research = entry.research[0];
      return { feedItemId: entry.id, symbol: entry.instrument!.symbol, name: entry.instrument!.name,
        title: entry.title.slice(0, 1000), url: safeUrl(entry.url)!, publishedAt: entry.publishedAt!.toISOString(), discoveredAt: entry.discoveredAt.toISOString(),
        classification: research?.classification ?? null,
        research: research ? { id: research.id, provider: research.provider, model: research.model, summary: research.summary, significance: research.significance, risks: research.risks, uncertainties: research.uncertainties, createdAt: research.createdAt.toISOString() } : null,
      };
    }).sort((a, b) => rank(a.classification) - rank(b.classification) || b.publishedAt.localeCompare(a.publishedAt) || a.feedItemId.localeCompare(b.feedItemId));
    const items = candidates.slice(0, 20);
    const lastSuccess = lastPipeline?.completedAt ?? null;
    const collectionStatus = !lastSuccess ? "unverified" : window.cutoffAt.getTime() - lastSuccess.getTime() > 75 * 60000 ? "stale" : "recent_pipeline_success";
    const content = {
      sessionDate: date, cutoffAt: window.cutoffAt.toISOString(), windowStart: window.windowStart.toISOString(), windowBasis: window.windowBasis,
      generatedAt: at.toISOString(), generatedAfterOpen: at >= window.opensAt,
      coverage: { universeCount, collectionStatus, lastPipelineCompletedAt: lastSuccess?.toISOString() ?? null,
        externalNews: "not_configured", earningsCalendar: "not_configured", globalMarkets: "not_configured", priceOutlook: "not_provided" },
      totalEligibleFilings: total, undatedFilingsExcluded: undatedCount, omittedFilings: total - items.length,
      watchlist: items.filter((entry) => entry.classification !== "IGNORE"), filings: items,
      limitations: ["Tracked-stock filings and existing research only; source completeness and distribution delay are not verified.",
        "Existing AI research is unverified and is not a trade recommendation.",
        "No earnings schedule, global-market feed, external-news feed or opening-price prediction is available."],
    };
    const markdown = [`# Swing — Morning Briefing | ${date} | 08:45 IST`,
      `Information cutoff: ${ist(window.cutoffAt)}. Window begins ${ist(window.windowStart)} (${window.windowBasis === "previous_session_close" ? "since the previous session closed" : "24-hour fallback; earlier calendar coverage is unavailable"}).`,
      `Coverage: ${universeCount} tracked stocks. Source collection: ${collectionStatus === "unverified" ? "no successful pipeline recorded" : collectionStatus === "stale" ? "last successful pipeline is over 75 minutes old" : "recent pipeline success; upstream delay remains unknown"}.`,
      ...(content.generatedAfterOpen ? ["Generated after market opening from stored information available by the cutoff."] : []),
      "## Overnight filings and research priorities",
      ...(items.length ? items.map((entry) => `- **${plain(entry.symbol)}** — [${plain(entry.title)}](${entry.url.replace(/[()\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}) · ${entry.classification ?? "NEEDS REVIEW"}${entry.research ? `\n  Existing AI research: ${plain(entry.research.summary)}` : "\n  No pre-cutoff AI research available."}`) : ["No eligible filings in the stored window. This does not establish that no market developments occurred."]),
      "## Coverage gaps", ...content.limitations.map((entry) => `- ${entry}`),
      `- ${undatedCount} undated filing(s) excluded; ${content.omittedFilings} eligible filing(s) omitted by report limits or invalid links.`,
    ].join("\n\n");
    const inserted = await tx.dailyBriefing.createMany({ data: [{ ...identity, cutoffAt: window.cutoffAt, windowStart: window.windowStart, generatedAt: at, content, markdown }], skipDuplicates: true });
    const report = await tx.dailyBriefing.findUniqueOrThrow({ where: { kind_sessionDate_reportVersion: identity } });
    return { status: inserted.count ? "generated" : "existing", report };
  });
}
