import "../src/lib/config/load-env";
import { enqueueJob, JobError } from "../src/lib/jobs/queue";
import { validateJobPayload } from "../src/lib/jobs/handlers";
import { closeDatabase, getDatabase } from "../src/lib/db";

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3) throw new JobError("INVALID_ARGUMENTS", true);
    const [kind, dedupeKey] = args;
    let payload: unknown = {};
    if (args[2]) {
      try { payload = JSON.parse(args[2]); } catch { throw new JobError("INVALID_JOB_PAYLOAD", true); }
    }
    const validated = validateJobPayload(kind, payload);
    const job = await enqueueJob(getDatabase(), { kind, dedupeKey, payload: validated });
    console.log(JSON.stringify({ event: "job_enqueued", id: job.id, kind: job.kind, status: job.status }));
  } catch (error) {
    console.error(JSON.stringify({ event: "job_enqueue_failed", code: error instanceof JobError ? error.code : "QUEUE_UNAVAILABLE" }));
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main();
