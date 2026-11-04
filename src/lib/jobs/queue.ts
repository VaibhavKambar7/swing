import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";

export type ClaimedJob = { id: string; kind: string; payload: Prisma.JsonValue; attempts: number; maxAttempts: number; lockedBy: string };
export const JOB_LEASE_MS = 120000;
export class JobError extends Error {
  constructor(public readonly code: string, public readonly permanent = false) {
    super(`Job failed: ${code}`);
  }
}

export function retryDelayMs(attempt: number) {
  return Math.min(300000, 5000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export async function enqueueJob(db: PrismaClient, input: { kind: string; dedupeKey: string; payload?: Prisma.InputJsonValue; maxAttempts?: number }) {
  if (!input.kind.trim() || input.kind.length > 100 || !input.dedupeKey.trim() || input.dedupeKey.length > 200 ||
      !Number.isInteger(input.maxAttempts ?? 5) || (input.maxAttempts ?? 5) < 1 || (input.maxAttempts ?? 5) > 20) {
    throw new JobError("INVALID_JOB", true);
  }
  await db.job.createMany({ data: [{ ...input, payload: input.payload ?? {} }], skipDuplicates: true });
  // A reused key must not silently refer to a different kind of work.
  const job = await db.job.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
  if (job.kind !== input.kind || job.maxAttempts !== (input.maxAttempts ?? 5) || canonical(job.payload) !== canonical(input.payload ?? {})) {
    throw new JobError("DEDUPE_KEY_CONFLICT", true);
  }
  return job;
}

export async function recoverExpiredJobs(db: PrismaClient) {
  return db.$executeRaw`
    UPDATE jobs SET
      status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'failed'::job_status WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'retry'::job_status END,
      completed_at = CASE WHEN cancel_requested_at IS NOT NULL OR attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
      run_after = clock_timestamp() + LEAST(300000, 5000 * power(2, LEAST(6, GREATEST(0, attempts - 1)))) * interval '1 millisecond',
      locked_by = NULL, locked_until = NULL,
      last_error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'JOB_CANCELLED' WHEN status = 'running' THEN 'LEASE_EXPIRED' ELSE 'ATTEMPTS_EXHAUSTED' END,
      updated_at = clock_timestamp()
    WHERE (status = 'running' AND locked_until <= clock_timestamp())
       OR (status IN ('pending', 'retry') AND (attempts >= max_attempts OR cancel_requested_at IS NOT NULL))
  `;
}

export async function claimJob(db: PrismaClient, workerId: string): Promise<ClaimedJob | null> {
  const token = `${workerId}:${randomUUID()}`;
  const rows = await db.$queryRaw<ClaimedJob[]>`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE status IN ('pending', 'retry') AND cancel_requested_at IS NULL AND run_after <= clock_timestamp() AND attempts < max_attempts
      ORDER BY run_after, created_at, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE jobs AS j SET status = 'running', attempts = j.attempts + 1,
      locked_by = ${token}, locked_until = clock_timestamp() + ${JOB_LEASE_MS} * interval '1 millisecond',
      completed_at = NULL, updated_at = clock_timestamp()
    FROM candidate WHERE j.id = candidate.id
    RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts AS "maxAttempts", j.locked_by AS "lockedBy"
  `;
  return rows[0] ?? null;
}

export async function renewJobLease(db: PrismaClient, job: ClaimedJob) {
  const count = await db.$executeRaw`
    UPDATE jobs SET locked_until = clock_timestamp() + ${JOB_LEASE_MS} * interval '1 millisecond', updated_at = clock_timestamp()
    WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${job.lockedBy} AND locked_until > clock_timestamp()
  `;
  return count === 1;
}

export async function finishJob(db: PrismaClient, job: ClaimedJob, error?: JobError) {
  const failed = !!error && (error.permanent || job.attempts >= job.maxAttempts);
  const status = error ? (failed ? "failed" : "retry") : "succeeded";
  const count = await db.$executeRaw`
    UPDATE jobs SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'failed'::job_status ELSE ${status}::job_status END,
      completed_at = CASE WHEN cancel_requested_at IS NOT NULL OR ${status} IN ('succeeded', 'failed') THEN clock_timestamp() ELSE NULL END,
      run_after = CASE WHEN ${status} = 'retry' THEN clock_timestamp() + ${retryDelayMs(job.attempts)} * interval '1 millisecond' ELSE run_after END,
      locked_by = NULL, locked_until = NULL, last_error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN 'JOB_CANCELLED' ELSE ${error?.code ?? null} END, updated_at = clock_timestamp()
    WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${job.lockedBy} AND locked_until > clock_timestamp()
  `;
  return count === 1 ? status : "lease_lost";
}
