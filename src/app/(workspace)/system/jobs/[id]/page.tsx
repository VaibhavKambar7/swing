import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { getJobDetail } from "@/lib/jobs/retry";
import { loadRead } from "@/lib/dashboard/queries";
import { Badge, DefinitionList, Empty, Header, Note, Panel, time, Unavailable } from "@/components/dashboard/components";
import { JobRetryForm } from "@/components/dashboard/job-retry-form";
export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadRead(() => getJobDetail(getDatabase(), id));
  if (!loaded.ok) return <><Header title="Job detail" description="Stored operation status and retry history." /><Unavailable /></>;
  const job = loaded.data; if (!job) notFound();
  return <><Link className="back-link" href="/system">← System status</Link><Header title={job.kind} description="Inspect the stored result before requesting another attempt cycle." />
    <Panel title="Operation"><DefinitionList values={{ State: <Badge value={job.status} />, Attempts: `${job.attempts} / ${job.maxAttempts}`, "Error code": job.lastErrorCode ?? "None", Created: time(job.createdAt), Updated: time(job.updatedAt), "Run after": time(job.runAfter), Finished: time(job.completedAt), "Lease expires": time(job.lockedUntil) }} /></Panel>
    {job.status === "failed" && job.completedAt && job.kind !== "unsupported" && <Panel title="Retry failed operation" subtitle="Explicit request; another bounded retry cycle uses the existing saved input"><JobRetryForm key={`${job.id}:${job.completedAt.toISOString()}`} id={job.id} finishedAt={job.completedAt.toISOString()} /></Panel>}
    <Panel title="Manual retry history" subtitle="Latest 20 requests; previous failure state is preserved">{job.retryRequests.length ? <div className="table-scroll"><table><thead><tr><th>Requested</th><th>Previous attempts</th><th>Previous error</th><th>Note</th></tr></thead><tbody>{job.retryRequests.map((request) => <tr key={request.id}><td className="time-cell">{time(request.requestedAt)}</td><td>{request.previousAttempts} / {request.previousLimit}</td><td>{request.previousError}</td><td className="reason-cell">{request.reason ?? "No note"}</td></tr>)}</tbody></table></div> : <Empty title="No manual retries requested">Automatic worker retries stay within the job’s current attempt cycle.</Empty>}</Panel>
    <Note>Opening this page does not run the job. Saved provider payloads and raw exception text are not displayed. Expired price slots cannot be replayed.</Note></>;
}
