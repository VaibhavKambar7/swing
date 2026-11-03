import "../src/lib/config/load-env";
import { getDatabase, closeDatabase } from "../src/lib/db";
import { getJobStatus } from "../src/lib/jobs/status";

async function main() {
  try {
    console.log(JSON.stringify({ event: "job_status", ...await getJobStatus(getDatabase()) }));
  } catch {
    console.error(JSON.stringify({ event: "job_status_failed", code: "QUEUE_UNAVAILABLE" }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
