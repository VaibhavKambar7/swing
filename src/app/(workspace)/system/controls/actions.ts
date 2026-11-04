"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { validateJobPayload } from "@/lib/jobs/handlers";
export async function submitJob(form: FormData) {
  let id: string | undefined;
  try {
    const kind = z.string().max(100).parse(form.get("kind"));
    const key = z.string().uuid().parse(form.get("requestId"));
    const text = z.string().max(2000).parse(form.get("payload"));
    if (form.get("confirm") !== "yes") throw new Error();
    const payload = validateJobPayload(kind, JSON.parse(text));
    const job = await enqueueJob(getDatabase(), { kind, dedupeKey: `web:${key}`, payload });
    id = job.id;
  } catch { }
  redirect(id ? `/system/jobs/${id}` : "/system/controls?status=failed");
}
export async function cancelJob(form: FormData) {
  const id = z.string().uuid().parse(form.get("id"));
  let status = "failed";
  try {
    if (form.get("confirm") !== "yes") throw new Error();
    const result = await getDatabase().job.updateMany({ where: { id, status: { in: ["pending", "retry", "running"] } }, data: { cancelRequestedAt: new Date(), updatedAt: new Date() } });
    status = result.count ? "cancellation-requested" : "changed";
  } catch { }
  redirect(`/system/controls?status=${status}`);
}
