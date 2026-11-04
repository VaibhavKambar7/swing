import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { getCurrentVersion, readInputSchema, WORKSPACE_OWNER, type ReadActionState } from "./read-state";
export const feedbackInputSchema = readInputSchema.omit({ state: true }).extend({
  choice: z.enum(["useful", "not-useful", "clear"]), reason: z.string().trim().max(500).default(""),
}).strict();
export async function saveFeedback(db: PrismaClient, input: unknown): Promise<ReadActionState> {
  const parsed = feedbackInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid feedback option and keep the note under 500 characters." };
  const { kind, id, version, choice, reason } = parsed.data;
  return db.$transaction(async (tx) => {
    const current = await getCurrentVersion(tx, kind, id);
    if (!current) return { ok: false, message: "This item is no longer available." };
    if (current !== version) return { ok: false, message: "This item has changed. Refresh before giving feedback on its latest version." };
    const column = Prisma.raw(({ announcement: "feed_item_id", movement: "signal_id", briefing: "daily_briefing_id" } as const)[kind]);
    if (choice === "clear") {
      await tx.$executeRaw(Prisma.sql`DELETE FROM research_feedback WHERE owner_key = ${WORKSPACE_OWNER} AND ${column} = ${id}::uuid AND content_version = ${version}`);
    } else {
      await tx.$executeRaw(Prisma.sql`INSERT INTO research_feedback (owner_key, ${column}, content_version, useful, reason)
        VALUES (${WORKSPACE_OWNER}, ${id}::uuid, ${version}, ${choice === "useful"}, ${reason || null})
        ON CONFLICT (owner_key, ${column}, content_version) DO UPDATE SET useful = EXCLUDED.useful, reason = EXCLUDED.reason, updated_at = CURRENT_TIMESTAMP`);
    }
    return { ok: true, message: choice === "clear" ? "Feedback cleared for this version." : "Feedback saved for this version." };
  });
}
export function feedbackForVersion(records: { contentVersion: string; useful: boolean; reason: string | null }[], version: string) {
  const record = records.find((f) => f.contentVersion === version);
  return record ? { useful: record.useful, reason: record.reason } : null;
}
export async function getFeedbackOverview(db: PrismaClient) {
  const [useful, notUseful, recent] = await db.$transaction([
    db.researchFeedback.count({ where: { ownerKey: WORKSPACE_OWNER, useful: true } }),
    db.researchFeedback.count({ where: { ownerKey: WORKSPACE_OWNER, useful: false } }),
    db.researchFeedback.findMany({ where: { ownerKey: WORKSPACE_OWNER }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50,
      select: { id: true, useful: true, reason: true, contentVersion: true, updatedAt: true,
        feedItem: { select: { id: true, title: true } }, signal: { select: { id: true, instrument: { select: { symbol: true } } } },
        dailyBriefing: { select: { id: true, kind: true, sessionDate: true } },
      },
    }),
  ], { isolationLevel: "RepeatableRead" });
  return { useful, notUseful, recent };
}
