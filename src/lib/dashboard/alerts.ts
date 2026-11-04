import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { inboxSql, type InboxItem } from "./queries";
import { getPreferences } from "./preferences";
import { WORKSPACE_OWNER } from "./read-state";
export const alertFiltersSchema = z.object({
  page: z.coerce.number().int().min(1).max(200).default(1),
  read: z.enum(["all", "unread", "read"]).default("all"),
});
export type FrontendAlert = Omit<InboxItem, "kind"> & { kind: "announcement" | "movement" | "briefing" };
export async function getFrontendAlerts(db: PrismaClient, input: z.infer<typeof alertFiltersSchema>) {
  const filters = alertFiltersSchema.parse(input);
  // Read preferences and items from one snapshot so a count matches its list.
  return db.$transaction(async (tx) => {
    const p = await getPreferences(tx);
    const eligible = Prisma.sql`WITH inbox AS (${inboxSql}), eligible AS (
      SELECT * FROM inbox WHERE
        ((kind = 'announcement' AND ${p.announcementsEnabled}) OR (kind = 'movement' AND ${p.movementsEnabled}))
        AND relevance <> 'routine'
        AND ((classification = 'INVESTIGATE' AND ${p.investigateEnabled}) OR (classification = 'WATCH' AND ${p.watchEnabled}) OR (classification = 'PENDING' AND ${p.unassessedEnabled}))
        AND (NOT ${p.watchlistOnly} OR EXISTS (SELECT 1 FROM watchlist_entries w WHERE w.owner_key = ${WORKSPACE_OWNER} AND w.instrument_id::text = inbox."instrumentId"))
      UNION ALL
      SELECT b.id::text, 'briefing'::text, CASE WHEN b.kind = 'morning' THEN 'Morning briefing' ELSE 'Preliminary closing summary' END, NULL::text,
        'PENDING'::text, 'briefing'::text, NULL::text, b.generated_at, b.cutoff_at, NULL::text, NULL::text,
        COALESCE(a.id::text, b.id::text), COALESCE(rs.content_version = COALESCE(a.id::text, b.id::text), false)
      FROM daily_briefings b
      LEFT JOIN LATERAL (SELECT id FROM post_open_assessments WHERE morning_briefing_id = b.id ORDER BY assessed_at DESC, id DESC LIMIT 1) a ON true
      LEFT JOIN read_states rs ON rs.daily_briefing_id = b.id AND rs.owner_key = ${WORKSPACE_OWNER}
      WHERE ${p.briefingsEnabled}
    )`;
    const where = Prisma.sql`WHERE (${filters.read} = 'all' OR "isRead" = (${filters.read} = 'read'))`;
    const items = await tx.$queryRaw<FrontendAlert[]>(Prisma.sql`${eligible} SELECT * FROM eligible ${where} ORDER BY "recordedAt" DESC, kind, id DESC LIMIT 25 OFFSET ${(filters.page - 1) * 25}`);
    const [counts] = await tx.$queryRaw<{ total: bigint; unread: bigint }[]>(Prisma.sql`${eligible} SELECT count(*) FILTER (WHERE ${filters.read} = 'all' OR "isRead" = (${filters.read} = 'read')) AS total, count(*) FILTER (WHERE NOT "isRead") AS unread FROM eligible`);
    return { items, total: Number(counts.total), unread: Number(counts.unread), preferences: p, page: filters.page };
  }, { isolationLevel: "RepeatableRead" });
}
