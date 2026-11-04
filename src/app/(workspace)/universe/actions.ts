"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/lib/db";
import { importUniverse, parseConstituentCsv } from "@/lib/instruments/universe";
export async function saveUniverse(form: FormData) {
  await requireAccess();
  let status = "failed";
  try {
    const text = String(form.get("content") ?? "");
    if (!text || Buffer.byteLength(text) > 800000 || form.get("confirm") !== "yes") throw new Error();
    const input = form.get("format") === "csv" ? parseConstituentCsv(text, String(form.get("source") ?? ""), String(form.get("effectiveDate") ?? "")) : JSON.parse(text);
    const result = await importUniverse(getDatabase(), input);
    status = result.duplicate ? "unchanged" : "saved";
    revalidatePath("/", "layout");
  } catch { /* Do not expose user input or database errors. */ }
  redirect(`/universe?status=${status}`);
}
