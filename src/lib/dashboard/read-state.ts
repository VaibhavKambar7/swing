import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";

// Single personal workspace until sign-in is introduced. Identity is server-owned.
export const WORKSPACE_OWNER = "workspace-owner";
export const readInputSchema = z.object({
  kind: z.enum(["announcement", "movement", "briefing"]),
  id: z.string().uuid(),
  version: z.union([z.literal("source"), z.string().uuid()]),
  state: z.enum(["read", "unread"]),
});
export type ReadActionState = { ok: boolean; message: string };
export function reviewState(states: { contentVersion: string; readAt: Date }[], version: string) {
  const state = states.find((s) => s.contentVersion === version);
  return { isRead: Boolean(state), readVersion: version, readAt: state?.readAt ?? null };
}

export async function getCurrentVersion(tx: Pick<PrismaClient, "feedItem" | "signal" | "dailyBriefing">, kind: "announcement" | "movement" | "briefing", id: string): Promise<string | null> {
  if (kind === "announcement") {
    const item = await tx.feedItem.findUnique({ where: { id }, select: { research: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } } } });
    return item ? item.research[0]?.id ?? "source" : null;
  } else if (kind === "movement") {
    const item = await tx.signal.findFirst({ where: { id, origin: "movement" }, select: { analyses: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } } } });
    return item ? item.analyses[0]?.id ?? "source" : null;
  } else {
    const item = await tx.dailyBriefing.findUnique({ where: { id }, select: { postOpenAssessments: { orderBy: [{ assessedAt: "desc" }, { id: "desc" }], take: 1, select: { id: true } } } });
    return item ? item.postOpenAssessments[0]?.id ?? id : null;
  }
}

export async function setReadState(db: PrismaClient, input: unknown): Promise<ReadActionState> {
  const parsed = readInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid review request. Refresh and try again." };
  const { kind, id, version, state } = parsed.data;
  return db.$transaction(async (tx) => {
    const current = await getCurrentVersion(tx, kind, id);
    if (!current) return { ok: false, message: "This item is no longer available." };
    if (current !== version) return { ok: false, message: "This item has changed. Refresh to review its latest assessment." };
    // Only a fixed, server-selected column enters SQL; all input values are parameters.
    const column = Prisma.raw(({ announcement: "feed_item_id", movement: "signal_id", briefing: "daily_briefing_id" } as const)[kind]);
    if (state === "read") {
      await tx.$executeRaw(Prisma.sql`INSERT INTO read_states (owner_key, ${column}, content_version)
        VALUES (${WORKSPACE_OWNER}, ${id}::uuid, ${version})
        ON CONFLICT (owner_key, ${column}) DO UPDATE
        SET content_version = EXCLUDED.content_version,
          read_at = CASE WHEN read_states.content_version = EXCLUDED.content_version THEN read_states.read_at ELSE CURRENT_TIMESTAMP END`);
    } else {
      // A stale tab must not erase an acknowledgement of a newer version.
      await tx.$executeRaw(Prisma.sql`DELETE FROM read_states WHERE owner_key = ${WORKSPACE_OWNER} AND ${column} = ${id}::uuid AND content_version = ${version}`);
    }
    return { ok: true, message: state === "read" ? "Marked as read." : "Marked as unread." };
  });
}
