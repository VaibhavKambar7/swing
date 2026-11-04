"use server";
import { requireAccess } from "@/lib/auth/require-access";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { validateJobPayload } from "@/lib/jobs/handlers";
export async function submitJob(form: FormData) {
  await requireAccess();
  let id: string | undefined;
  try {
    const kind = z.string().max(100).parse(form.get("kind"));
    const key = z.string().uuid().parse(form.get("requestId"));
    const limit = Number(form.get("limit") ?? 1);
    const analyze = form.get("analyze") === "yes";
    const input = kind === "announcements.research-item" ? { feedItemId: form.get("feedItemId") } : kind === "prices.collect" ? { symbol: form.get("symbol"), days: Number(form.get("days")) }
      : kind === "sources.collect" ? { sourceId: form.get("sourceId") }
      : kind === "movements.research" ? { signalId: form.get("signalId"), analyze }
      : kind.startsWith("briefings.") ? { sessionDate: form.get("sessionDate") }
      : kind === "announcements.pipeline" ? { analyze, analysisLimit: limit }
      : ["announcements.analyze", "research.followups"].includes(kind) ? { limit } : {};
    if (form.get("confirm") !== "yes") throw new Error();
    const payload = validateJobPayload(kind, input);
    const job = await enqueueJob(getDatabase(), { kind, dedupeKey: `web:${key}`, payload });
    id = job.id;
  } catch { }
  redirect(id ? `/system/jobs/${id}` : "/system/controls?status=failed");
}
export async function cancelJob(form: FormData) {
  await requireAccess();
  let status = "failed";
  try {
    const id = z.string().uuid().parse(form.get("id"));
    if (form.get("confirm") !== "yes") throw new Error();
    const result = await getDatabase().job.updateMany({ where: { id, status: { in: ["pending", "retry", "running"] } }, data: { cancelRequestedAt: new Date(), updatedAt: new Date() } });
    status = result.count ? "cancellation-requested" : "changed";
  } catch { }
  redirect(`/system/controls?status=${status}`);
}
