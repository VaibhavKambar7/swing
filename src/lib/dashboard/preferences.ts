import type { PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { WORKSPACE_OWNER, type ReadActionState } from "./read-state";

export const preferencesSchema = z.object({
  announcementsEnabled: z.boolean(), movementsEnabled: z.boolean(), briefingsEnabled: z.boolean(),
  investigateEnabled: z.boolean(), watchEnabled: z.boolean(), unassessedEnabled: z.boolean(), watchlistOnly: z.boolean(),
}).strict();
export type AlertPreferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: AlertPreferences = {
  announcementsEnabled: true, movementsEnabled: true, briefingsEnabled: true,
  investigateEnabled: true, watchEnabled: true, unassessedEnabled: false, watchlistOnly: false,
};
export async function getPreferences(db: Pick<PrismaClient, "workspacePreferences">): Promise<AlertPreferences> {
  const saved = await db.workspacePreferences.findUnique({ where: { ownerKey: WORKSPACE_OWNER } });
  return saved ? preferencesSchema.parse({
    announcementsEnabled: saved.announcementsEnabled, movementsEnabled: saved.movementsEnabled,
    briefingsEnabled: saved.briefingsEnabled, investigateEnabled: saved.investigateEnabled,
    watchEnabled: saved.watchEnabled, unassessedEnabled: saved.unassessedEnabled, watchlistOnly: saved.watchlistOnly,
  }) : { ...defaultPreferences };
}
export async function savePreferences(db: PrismaClient, input: unknown): Promise<ReadActionState> {
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid alert preferences." };
  await db.workspacePreferences.upsert({ where: { ownerKey: WORKSPACE_OWNER },
    create: { ownerKey: WORKSPACE_OWNER, ...parsed.data }, update: { ...parsed.data, updatedAt: new Date() },
  });
  return { ok: true, message: "Alert preferences saved." };
}
export async function changeWatchlist(db: PrismaClient, input: unknown): Promise<ReadActionState> {
  const parsed = z.object({ instrumentId: z.string().uuid(), operation: z.enum(["add", "remove"]) }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid stock." };
  const { instrumentId, operation } = parsed.data;
  if (operation === "remove") {
    await db.watchlistEntry.deleteMany({ where: { ownerKey: WORKSPACE_OWNER, instrumentId } });
    return { ok: true, message: "Stock removed from your watchlist." };
  }
  const stock = await db.instrument.findFirst({ where: { id: instrumentId, active: true, kind: "equity", inUniverse: true } });
  if (!stock) return { ok: false, message: "Choose an active stock from the configured research universe." };
  await db.watchlistEntry.upsert({ where: { ownerKey_instrumentId: { ownerKey: WORKSPACE_OWNER, instrumentId } },
    create: { ownerKey: WORKSPACE_OWNER, instrumentId }, update: {},
  });
  return { ok: true, message: "Stock added to your watchlist." };
}
export function getWatchlist(db: PrismaClient) {
  return db.watchlistEntry.findMany({ where: { ownerKey: WORKSPACE_OWNER },
    orderBy: [{ instrument: { symbol: "asc" } }, { instrumentId: "asc" }],
    select: { instrumentId: true, createdAt: true, instrument: { select: { symbol: true, name: true, exchange: true, active: true, inUniverse: true } } },
  });
}
