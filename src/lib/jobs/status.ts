import type { PrismaClient } from "../../generated/prisma/client";
import { JOB_KINDS } from "./handlers";

export function publicJobKind(kind: string) {
  return (JOB_KINDS as readonly string[]).includes(kind) ? kind : "unsupported";
}

export async function getJobStatus(db: PrismaClient, at = new Date()) {
  const due = { status: { in: ["pending" as const, "retry" as const] }, runAfter: { lte: at } };
  const groupsQuery = db.job.groupBy({ by: ["status"], orderBy: { status: "asc" }, _count: { _all: true } });
  const [groups, dueJobs, expiredLeases, failures, lastPipeline, checkpoint, priceCheckpoint, priceCollection] = await db.$transaction([
    groupsQuery,
    db.job.count({ where: due }),
    db.job.count({ where: { status: "running", lockedUntil: { lte: at } } }),
    db.job.findMany({ where: { status: "failed" }, orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 10,
      select: { id: true, kind: true, attempts: true, maxAttempts: true, lastErrorCode: true, completedAt: true } }),
    db.job.findFirst({ where: { kind: "announcements.pipeline", status: "succeeded" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
    db.pollingCheckpoint.findUnique({ where: { source_scope: { source: "swing-scheduler", scope: "announcements-v1" } },
      select: { lastAttemptAt: true, lastSuccessAt: true } }),
    db.pollingCheckpoint.findUnique({ where: { source_scope: { source: "swing-scheduler", scope: "prices-v1" } }, select: { lastAttemptAt: true, lastSuccessAt: true, cursor: true } }),
    db.pollingCheckpoint.findFirst({ where: { source: "market-import", lastSuccessAt: { not: null } }, orderBy: { lastSuccessAt: "desc" }, select: { lastSuccessAt: true } }),
  ], { isolationLevel: "RepeatableRead" });
  const counts = { pending: 0, running: 0, retry: 0, succeeded: 0, failed: 0 };
  for (const group of groups) counts[group.status] = group._count._all;
  return {
    asOf: at.toISOString(), counts, dueJobs, expiredLeases,
    hasFailedJobs: counts.failed > 0,
    recentFailures: failures.map((job) => ({ ...job,
      kind: publicJobKind(job.kind),
      lastErrorCode: job.lastErrorCode && /^[A-Z][A-Z0-9_]{0,99}$/.test(job.lastErrorCode) ? job.lastErrorCode : "UNKNOWN_ERROR",
    })),
    lastPipelineCompletedAt: lastPipeline?.completedAt ?? null,
    schedulerCheckpoint: checkpoint, priceSchedulerCheckpoint: priceCheckpoint,
    lastPriceCollectionAt: priceCollection?.lastSuccessAt ?? null,
  };
}
