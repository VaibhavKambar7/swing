import type { PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { validateJobPayload } from "./handlers";
import { publicJobKind } from "./status";
import { WORKSPACE_OWNER, type ReadActionState } from "../dashboard/read-state";
export function publicErrorCode(value: string | null) {
  return value && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : "UNKNOWN_ERROR";
}
const retrySchema = z.object({ id: z.string().uuid(), finishedAt: z.string().datetime(),
  confirmed: z.literal(true), reason: z.string().trim().max(500).default("") }).strict();
export async function retryFailedJob(db: PrismaClient, input: unknown, at = new Date()): Promise<ReadActionState> {
  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Confirm the retry and keep any note under 500 characters." };
  const { id, finishedAt, reason } = parsed.data;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${id}::uuid FOR UPDATE`;
    const job = await tx.job.findUnique({ where: { id } });
    if (!job) return { ok: false, message: "This job is no longer available." };
    if (job.status !== "failed" || !job.completedAt || job.completedAt.getTime() !== Date.parse(finishedAt)) return { ok: false, message: "This job has changed. Refresh its current state before retrying." };
    try {
      const payload = validateJobPayload(job.kind, job.payload);
      if (job.kind === "prices.collect" && "validUntil" in payload && payload.validUntil && Date.parse(payload.validUntil) <= at.getTime()) return { ok: false, message: "This price polling slot has expired. Let the scheduler collect a current observation." };
    } catch { return { ok: false, message: "The saved job kind or payload is unsupported. Fix its configuration instead of replaying it." }; }
    await tx.jobRetryRequest.create({ data: { jobId: id, ownerKey: WORKSPACE_OWNER, previousAttempts: job.attempts,
      previousLimit: job.maxAttempts, previousError: publicErrorCode(job.lastErrorCode), previousFinishedAt: job.completedAt, requestedAt: at, reason: reason || null,
    } });
    await tx.job.update({ where: { id }, data: { status: "pending", attempts: 0, runAfter: at, completedAt: null,
      lockedBy: null, lockedUntil: null, lastErrorCode: null, updatedAt: at,
    } });
    return { ok: true, message: "Job queued for another bounded attempt cycle. The worker will process it." };
  });
}
export async function getJobDetail(db: PrismaClient, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const job = await db.job.findUnique({ where: { id }, select: {
    id: true, kind: true, status: true, attempts: true, maxAttempts: true, lastErrorCode: true,
    createdAt: true, updatedAt: true, completedAt: true, runAfter: true, lockedUntil: true,
    retryRequests: { where: { ownerKey: WORKSPACE_OWNER }, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], take: 20,
      select: { id: true, previousAttempts: true, previousLimit: true, previousError: true, previousFinishedAt: true, requestedAt: true, reason: true } },
  } });
  return job ? { ...job, kind: publicJobKind(job.kind), lastErrorCode: job.lastErrorCode ? publicErrorCode(job.lastErrorCode) : null,
    retryRequests: job.retryRequests.map((request) => ({ ...request, previousError: publicErrorCode(request.previousError) })),
  } : null;
}
