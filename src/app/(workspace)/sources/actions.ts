"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db";
export async function saveSource(form: FormData) {
  let status = "failed";
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(100), query: z.string().trim().min(3).max(300) }).parse({ name: form.get("name"), query: form.get("query") });
    if (await getDatabase().feedSource.count() >= 20) throw new Error();
    await getDatabase().feedSource.create({ data: { id: randomUUID(), kind: "news-search", ...parsed, enabled: true } }); status = "saved";
  } catch { }
  redirect(`/sources?status=${status}`);
}
export async function toggleSource(form: FormData) {
  let status = "failed";
  try { const id = z.string().min(1).max(100).parse(form.get("id")); await getDatabase().feedSource.update({ where: { id }, data: { enabled: form.get("enabled") === "true", updatedAt: new Date() } }); status = "saved"; } catch { }
  redirect(`/sources?status=${status}`);
}
