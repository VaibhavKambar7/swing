"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db";
import { saveFeedback } from "@/lib/dashboard/feedback";
import type { ReadActionState } from "@/lib/dashboard/read-state";
export async function updateFeedback(_previous: ReadActionState, form: FormData): Promise<ReadActionState> {
  await requireAccess();
  try {
    const result = await saveFeedback(getDatabase(), { kind: form.get("kind"), id: form.get("id"), version: form.get("version"), choice: form.get("choice"), reason: form.get("reason") });
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch { return { ok: false, message: "Could not save feedback. Check the database connection and try again." }; }
}
