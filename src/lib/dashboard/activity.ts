import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { getAlertSummary } from "./alerts";

// Fixed server-owned identifiers. Never interpolate a browser-provided table name.
const collections = [
  ["feed_items", "greatest(discovered_at, match_checked_at, relevance_checked_at)"], ["feed_research", "created_at"], ["signals", "created_at"],
  ["analyses", "created_at"], ["daily_briefings", "generated_at"], ["post_open_assessments", "assessed_at"],
  ["read_states", "read_at"], ["workspace_preferences", "updated_at"], ["watchlist_entries", "created_at"],
  ["research_feedback", "updated_at"], ["research_followups", "updated_at"], ["instruments", "updated_at"],
] as const;
export async function getWorkspaceActivity(db: PrismaClient) {
  const [summaries, alerts] = await Promise.all([
    db.$transaction(collections.map(([table, column]) => db.$queryRaw<{ count: string; latest: string | null }[]>(
      Prisma.sql`SELECT count(*)::text AS count, max(${Prisma.raw(column)})::text AS latest FROM ${Prisma.raw(table)}`
    )), { isolationLevel: "RepeatableRead" }),
    getAlertSummary(db),
  ]);
  const revision = createHash("sha256").update(JSON.stringify({ summaries, alerts })).digest("hex");
  return { revision, unreadAlerts: alerts.unread, checkedAt: new Date().toISOString() };
}
