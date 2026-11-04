"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db";
export async function saveSource(form: FormData) {
  await requireAccess();
  let status = "failed";
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(100), query: z.string().trim().min(3).max(300) }).parse({ name: form.get("name"), query: form.get("query") });
    if (await getDatabase().feedSource.count({ where: { enabled: true } }) >= 20) throw new Error();
    await getDatabase().feedSource.create({ data: { id: randomUUID(), kind: "news-search", ...parsed, enabled: true } }); status = "saved";
  } catch { }
  redirect(`/sources?status=${status}`);
}
export async function toggleSource(form: FormData) {
  await requireAccess();
  let status = "failed";
  try { const id = z.string().min(1).max(100).parse(form.get("id")); const enabled = z.enum(["true", "false"]).parse(form.get("enabled")) === "true"; if (enabled && await getDatabase().feedSource.count({ where: { enabled: true } }) >= 20) throw new Error(); await getDatabase().feedSource.update({ where: { id }, data: { enabled, updatedAt: new Date() } }); status = "saved"; } catch { }
  redirect(`/sources?status=${status}`);
}
