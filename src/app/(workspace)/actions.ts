"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db";
import { setReadState, type ReadActionState } from "@/lib/dashboard/read-state";

export async function updateReadState(_previous: ReadActionState, form: FormData): Promise<ReadActionState> {
  await requireAccess();
  try {
    const result = await setReadState(getDatabase(), {
      kind: form.get("kind"), id: form.get("id"), version: form.get("version"), state: form.get("state"),
    });
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch {
    return { ok: false, message: "Could not save review state. Check the database connection and try again." };
  }
}
