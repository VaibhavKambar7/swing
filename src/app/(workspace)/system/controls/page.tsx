import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { JOB_KINDS } from "@/lib/jobs/handlers";
import { loadRead } from "@/lib/dashboard/queries";
import { Header, Panel, Note, Unavailable, time } from "@/components/dashboard/components";
import { submitJob, cancelJob } from "./actions";
export default async function Controls({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const jobs = await loadRead(() => getDatabase().job.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, kind: true, status: true, createdAt: true, cancelRequestedAt: true } }));
  return <><Header title="Job controls" description="Explicit worker operations. Loading this page never calls a provider." />{status && <Note>{status === "cancellation-requested" ? "Cancellation requested. In-flight calls may already have completed; stored evidence is retained." : "Request could not be applied. Validate the payload or refresh the current job state."}</Note>}
  <Panel title="Queue an operation"><form action={submitJob}><input type="hidden" name="requestId" value={randomUUID()} /><label>Operation <select name="kind">{JOB_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>JSON payload <textarea name="payload" required maxLength={2000} rows={5} defaultValue="{}" /></label><label><input type="checkbox" name="confirm" value="yes" required /> Run this operation. Provider work can use configured network access; explicit AI operations can consume quota.</label><button className="button">Queue operation</button></form>
  <p>Payloads: fetch/match/filter/database.check: <code>{"{}"}</code>; pipeline: <code>{'{"analyze":false,"analysisLimit":1}'}</code>; analyze: <code>{'{"limit":1}'}</code>; prices.collect: <code>{'{"symbol":"TCS","days":7}'}</code>; movements.research: <code>{'{"signalId":"UUID","analyze":false}'}</code>; briefings: <code>{'{"sessionDate":"YYYY-MM-DD"}'}</code>; research.followups: <code>{'{"limit":25}'}</code>; sources.collect: <code>{'{"sourceId":"nse"}'}</code>.</p></Panel>
  {!jobs.ok ? <Unavailable /> : <Panel title="Recent operations">{jobs.data.length ? jobs.data.map((job) => <article key={job.id}><p><Link href={`/system/jobs/${job.id}`}>{job.kind}</Link> · {job.status} · {time(job.createdAt)}</p>{["pending", "retry", "running"].includes(job.status) && <form action={cancelJob}><input type="hidden" name="id" value={job.id} /><label><input type="checkbox" name="confirm" value="yes" required /> Confirm cancellation</label><button className="button secondary" disabled={Boolean(job.cancelRequestedAt)}>{job.cancelRequestedAt ? "Cancellation pending" : "Cancel operation"}</button></form>}</article>) : <p>No operations queued.</p>}</Panel>}</>;
}
