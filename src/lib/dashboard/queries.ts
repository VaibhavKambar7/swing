import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { getJobStatus } from "../jobs/status";
import { WORKSPACE_OWNER, reviewState } from "./read-state";
import { feedbackForVersion } from "./feedback";

export const inboxFiltersSchema = z.object({
  kind: z.enum(["all", "announcement", "movement"]).default("all"),
  classification: z.enum(["all", "INVESTIGATE", "WATCH", "IGNORE", "PENDING"]).default("all"),
  stock: z.string().trim().max(30).regex(/^[a-zA-Z0-9&_.-]*$/).transform((v) => v.toUpperCase()).default(""),
  read: z.enum(["all", "unread", "read"]).default("all"),
  page: z.coerce.number().int().min(1).max(200).default(1),
});
export type InboxFilters = z.infer<typeof inboxFiltersSchema>;
export type InboxItem = {
  id: string; kind: "announcement" | "movement"; title: string; symbol: string | null;
  classification: "INVESTIGATE" | "WATCH" | "IGNORE" | "PENDING";
  isRead: boolean; readVersion: string; instrumentId: string | null;
  relevance: string; summary: string | null; recordedAt: Date; eventAt: Date | null; changePct: string | null;
};
// Latest assessment wins, including filters: a past INVESTIGATE must not match
// an item whose latest research is IGNORE. Values are parameterized below.
export const inboxSql = Prisma.sql`
  SELECT f.id::text, 'announcement'::text AS kind, f.title, i.symbol,
    COALESCE(r.classification::text, 'PENDING') AS classification,
    f.relevance_status::text AS relevance, r.summary,
    f.discovered_at AS "recordedAt", f.published_at AS "eventAt", NULL::text AS "changePct", f.instrument_id::text AS "instrumentId",
    COALESCE(r.id::text, 'source') AS "readVersion", COALESCE(rs.content_version = COALESCE(r.id::text, 'source'), false) AS "isRead"
  FROM feed_items f LEFT JOIN instruments i ON i.id = f.instrument_id
  LEFT JOIN LATERAL (SELECT id, classification, summary FROM feed_research WHERE feed_item_id = f.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true
  LEFT JOIN read_states rs ON rs.feed_item_id = f.id AND rs.owner_key = ${WORKSPACE_OWNER}
  UNION ALL
  SELECT s.id::text, 'movement'::text, i.symbol || ' · price movement', i.symbol,
    CASE WHEN a.assessment->>'classification' IN ('INVESTIGATE','WATCH','IGNORE') THEN a.assessment->>'classification' ELSE 'PENDING' END,
    'movement'::text, a.summary, s.created_at, s.observed_at, s.price_change_pct::text, s.instrument_id::text,
    COALESCE(a.id::text, 'source'), COALESCE(rs.content_version = COALESCE(a.id::text, 'source'), false)
  FROM signals s JOIN instruments i ON i.id = s.instrument_id
  LEFT JOIN LATERAL (SELECT id, summary, assessment FROM analyses WHERE signal_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) a ON true
  LEFT JOIN read_states rs ON rs.signal_id = s.id AND rs.owner_key = ${WORKSPACE_OWNER}
  WHERE s.origin = 'movement'`;

export async function getInbox(db: PrismaClient, filters: InboxFilters, size = 25) {
  filters = inboxFiltersSchema.parse(filters);
  z.number().int().min(1).max(50).parse(size);
  const where = Prisma.sql`WHERE (${filters.kind} = 'all' OR kind = ${filters.kind})
    AND (${filters.classification} = 'all' OR classification = ${filters.classification})
    AND (${filters.stock} = '' OR symbol = ${filters.stock})
    AND (${filters.read} = 'all' OR "isRead" = (${filters.read} = 'read'))`;
  const [items, counts] = await db.$transaction([
    db.$queryRaw<InboxItem[]>(Prisma.sql`WITH inbox AS (${inboxSql}) SELECT * FROM inbox ${where}
      ORDER BY "recordedAt" DESC, kind, id DESC LIMIT ${size} OFFSET ${(filters.page - 1) * size}`),
    db.$queryRaw<{ total: bigint }[]>(Prisma.sql`WITH inbox AS (${inboxSql}) SELECT count(*) AS total FROM inbox ${where}`),
  ], { isolationLevel: "RepeatableRead" });
  return { items, total: Number(counts[0].total), page: filters.page, pageSize: size };
}
export async function getUnreadCounts(db: PrismaClient) {
  const [result] = await db.$queryRaw<{ research: bigint; briefings: bigint }[]>(Prisma.sql`
    WITH inbox AS (${inboxSql})
    SELECT (SELECT count(*) FROM inbox WHERE NOT "isRead") AS research,
      (SELECT count(*) FROM daily_briefings b
       LEFT JOIN LATERAL (SELECT id FROM post_open_assessments WHERE morning_briefing_id = b.id ORDER BY assessed_at DESC, id DESC LIMIT 1) p ON true
       LEFT JOIN read_states rs ON rs.daily_briefing_id = b.id AND rs.owner_key = ${WORKSPACE_OWNER}
       WHERE rs.content_version IS DISTINCT FROM COALESCE(p.id::text, b.id::text)) AS briefings`);
  return { research: Number(result.research), briefings: Number(result.briefings) };
}
export async function getOverview(db: PrismaClient) {
  const [stocks, announcements, movements, pending, lastFiling, lastQuote, queue, briefings] = await Promise.all([
    db.instrument.count({ where: { active: true, inUniverse: true, kind: "equity" } }),
    db.feedItem.count(), db.signal.count({ where: { origin: "movement" } }),
    db.feedItem.count({ where: { matchStatus: "matched", relevanceStatus: { in: ["keep", "review"] }, research: { none: {} } } }),
    db.feedItem.findFirst({ orderBy: [{ discoveredAt: "desc" }, { id: "desc" }], select: { discoveredAt: true, publishedAt: true } }),
    db.marketSnapshotRecord.findFirst({ orderBy: [{ retrievedAt: "desc" }, { id: "desc" }], select: { retrievedAt: true, quoteTime: true, quoteDelayStatus: true } }),
    getJobStatus(db), getBriefings(db, 3),
  ]);
  return { stocks, announcements, movements, pending, lastFiling, lastQuote, queue, briefings };
}
export function getStocks(db: PrismaClient) {
  return db.instrument.findMany({ where: { kind: "equity" }, orderBy: { symbol: "asc" }, take: 500, select: { symbol: true } });
}
export async function getBriefings(db: PrismaClient, take = 25) {
  const reports = await db.dailyBriefing.findMany({ take, orderBy: [{ cutoffAt: "desc" }, { id: "desc" }], select: {
    id: true, kind: true, sessionDate: true, reportVersion: true, cutoffAt: true, generatedAt: true,
    _count: { select: { postOpenAssessments: true } },
    readStates: { where: { ownerKey: WORKSPACE_OWNER }, select: { contentVersion: true, readAt: true } },
    postOpenAssessments: { orderBy: [{ assessedAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } },
  } });
  return reports.map((report) => ({ ...report, ...reviewState(report.readStates, report.postOpenAssessments[0]?.id ?? report.id) }));
}
export async function getReport(db: PrismaClient, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const report = await db.dailyBriefing.findUnique({ where: { id }, include: {
    researchFeedback: { where: { ownerKey: WORKSPACE_OWNER }, select: { contentVersion: true, useful: true, reason: true } },
    readStates: { where: { ownerKey: WORKSPACE_OWNER }, select: { contentVersion: true, readAt: true } },
    postOpenAssessments: { orderBy: [{ assessedAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, status: true, reason: true, assessedAt: true, instrument: { select: { symbol: true } } } },
  } });
  return report ? { ...report, feedback: feedbackForVersion(report.researchFeedback, report.postOpenAssessments[0]?.id ?? report.id), ...reviewState(report.readStates, report.postOpenAssessments[0]?.id ?? report.id) } : null;
}
export const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = URL.parse(value);
  return url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
}
export async function getResearchDetail(db: PrismaClient, kind: string, id: string) {
  if (!["announcement", "movement"].includes(kind) || !z.string().uuid().safeParse(id).success) return null;
  if (kind === "announcement") {
    const item = await db.feedItem.findUnique({ where: { id }, include: { researchFeedback: { where: { ownerKey: WORKSPACE_OWNER } }, readStates: { where: { ownerKey: WORKSPACE_OWNER } }, instrument: true, research: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5 } } });
    if (!item) return null;
    return {
      ...reviewState(item.readStates, item.research[0]?.id ?? "source"),
      feedback: feedbackForVersion(item.researchFeedback, item.research[0]?.id ?? "source"),
      id, kind: "announcement" as const, title: item.title, symbol: item.instrument?.symbol ?? "Unmatched issuer", sourceText: item.description,
      marketContext: null,
      facts: { "Published": item.publishedAt, "Discovered": item.discoveredAt, "Match checked": item.matchCheckedAt, "Filter checked": item.relevanceCheckedAt },
      meta: { "Issuer matching": item.matchStatus, "Relevance": item.relevanceStatus, "Filter reason": item.relevanceReason ?? "Not assessed", "Source": item.source },
      evidence: [{ title: item.title, url: safeSourceUrl(item.url) }],
      research: item.research.map((r) => ({ ...r, classification: String(r.classification), significance: r.significance, risks: stringList(r.risks), uncertainties: stringList(r.uncertainties) })),
    };
  }
  const item = await db.signal.findFirst({ where: { id, origin: "movement" }, include: {
    researchFeedback: { where: { ownerKey: WORKSPACE_OWNER } }, readStates: { where: { ownerKey: WORKSPACE_OWNER } }, instrument: true, analyses: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5 },
    signalEvidence: { orderBy: { retrievedAt: "desc" }, take: 20 },
  } });
  if (!item) return null;
  return {
    ...reviewState(item.readStates, item.analyses[0]?.id ?? "source"),
    feedback: feedbackForVersion(item.researchFeedback, item.analyses[0]?.id ?? "source"),
    id, kind: "movement" as const, title: `${item.instrument.symbol} · observed price movement`, symbol: item.instrument.symbol, sourceText: null,
    marketContext: item.context && typeof item.context === "object" && !Array.isArray(item.context) ? item.context.marketContext : null,
    facts: { "Observed": item.observedAt, "Reference time": item.windowStart, "Stored": item.createdAt },
    meta: { "Change": item.priceChangePct ? `${item.priceChangePct.toFixed(2)}%` : "Unavailable", "Observed price": item.price?.toString() ?? "Unavailable", "Reference price": item.referencePrice?.toString() ?? "Unavailable", "Detector": item.detectorVersion },
    evidence: item.signalEvidence.map((e) => ({ title: e.title, url: safeSourceUrl(e.url) })),
    research: item.analyses.map((r) => {
      const assessment = object(r.assessment);
      return { ...r, classification: typeof assessment.classification === "string" && ["INVESTIGATE", "WATCH", "IGNORE"].includes(assessment.classification) ? assessment.classification : "PENDING", significance: typeof assessment.significance === "string" ? assessment.significance : null, risks: stringList(r.risks), uncertainties: stringList(r.uncertainties) };
    }),
  };
}
export async function loadRead<T>(read: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try { return { ok: true, data: await read() }; } catch { return { ok: false }; }
}
export function collectionState(lastSuccess: Date | null, at = new Date()): "unknown" | "recent" | "stale" {
  if (!lastSuccess || lastSuccess > at) return "unknown";
  return at.getTime() - lastSuccess.getTime() <= 75 * 60000 ? "recent" : "stale";
}
