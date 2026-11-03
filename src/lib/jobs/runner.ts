import type { PrismaClient } from "../../generated/prisma/client";
import { claimJob, finishJob, JobError, recoverExpiredJobs, renewJobLease, type ClaimedJob } from "./queue";

export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

export async function runJobOnce(db: PrismaClient, workerId: string, handlers: JobHandlers, stop?: AbortSignal) {
  if (stop?.aborted) return { status: "stopped" };
  await recoverExpiredJobs(db);
  const job = await claimJob(db, workerId);
  if (!job) return { status: "idle" };
  const controller = new AbortController();
  const onStop = () => controller.abort();
  stop?.addEventListener("abort", onStop, { once: true });
  if (stop?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewing: Promise<void> = Promise.resolve();
  let done = false;
  const renew = async () => {
    try {
      if (!await renewJobLease(db, job)) controller.abort();
    } catch {
      controller.abort();
    }
    if (!done && !controller.signal.aborted) timer = setTimeout(() => { renewing = renew(); }, 30000);
  };
  timer = setTimeout(() => { renewing = renew(); }, 30000);
  let error: JobError | undefined;
  try {
    controller.signal.throwIfAborted();
    const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : undefined;
    if (!handler) throw new JobError("UNSUPPORTED_JOB_KIND", true);
    await handler(job, controller.signal);
    controller.signal.throwIfAborted();
  } catch (cause) {
    // Never persist raw exception messages or provider/database connection details.
    error = controller.signal.aborted ? new JobError("JOB_INTERRUPTED") : cause instanceof JobError ? cause : new JobError("HANDLER_FAILED");
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    await renewing;
    stop?.removeEventListener("abort", onStop);
  }
  const status = await finishJob(db, job, error);
  return { status, jobId: job.id, kind: job.kind, attempt: job.attempts, errorCode: error?.code };
}
