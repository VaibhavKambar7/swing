"use server";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db";
import { changeWatchlist, savePreferences } from "@/lib/dashboard/preferences";
import type { ReadActionState } from "@/lib/dashboard/read-state";
export async function updatePreferences(_previous: ReadActionState, form: FormData): Promise<ReadActionState> {
  try {
    const result = await savePreferences(getDatabase(), {
      announcementsEnabled: form.get("announcementsEnabled") === "on", movementsEnabled: form.get("movementsEnabled") === "on",
      briefingsEnabled: form.get("briefingsEnabled") === "on", investigateEnabled: form.get("investigateEnabled") === "on",
      watchEnabled: form.get("watchEnabled") === "on", unassessedEnabled: form.get("unassessedEnabled") === "on",
      watchlistOnly: form.get("watchlistOnly") === "on",
    });
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch { return { ok: false, message: "Could not save preferences. Check the database connection and try again." }; }
}
export async function updateWatchlist(_previous: ReadActionState, form: FormData): Promise<ReadActionState> {
  try {
    const result = await changeWatchlist(getDatabase(), { instrumentId: form.get("instrumentId"), operation: form.get("operation") });
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch { return { ok: false, message: "Could not update your watchlist. Check the database connection and try again." }; }
}
