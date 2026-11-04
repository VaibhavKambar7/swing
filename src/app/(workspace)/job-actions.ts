"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db";
import { retryFailedJob } from "@/lib/jobs/retry";
import type { ReadActionState } from "@/lib/dashboard/read-state";
export async function retryJobAction(_previous: ReadActionState, form: FormData): Promise<ReadActionState> {
  await requireAccess();
  try {
    const result = await retryFailedJob(getDatabase(), { id: form.get("id"), finishedAt: form.get("finishedAt"), confirmed: form.get("confirmed") === "on", reason: form.get("reason") });
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch { return { ok: false, message: "Could not queue the retry. Check the database connection and refresh." }; }
}
