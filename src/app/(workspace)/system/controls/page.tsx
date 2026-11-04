import { Pagination, pageNumber } from "@/components/dashboard/pagination";
import { OperationForm } from "@/components/dashboard/operation-form";
import { marketDate } from "@/lib/market/calendar";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { loadRead } from "@/lib/dashboard/queries";
import { Header, Panel, Note, Unavailable, time } from "@/components/dashboard/components";
import { cancelJob } from "./actions";
export default async function Controls({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const { status, page: inputPage } = await searchParams;
  const page = pageNumber(inputPage);
  const jobs = await loadRead(() => getDatabase().job.findMany({ orderBy: { createdAt: "desc" }, take: 100, skip: (page - 1) * 100, select: { id: true, kind: true, status: true, createdAt: true, cancelRequestedAt: true } }));
  const options = await loadRead(async () => ({
    stocks: await getDatabase().instrument.findMany({ where: { exchange: "NSE", active: true, inUniverse: true }, select: { symbol: true, name: true }, orderBy: { symbol: "asc" }, take: 2000 }),
    sources: await getDatabase().feedSource.findMany({ where: { enabled: true }, select: { id: true, name: true } }),
    movements: await getDatabase().signal.findMany({ where: { origin: "movement" }, select: { id: true, observedAt: true, priceChangePct: true, instrument: { select: { symbol: true } } }, orderBy: { observedAt: "desc" }, take: 200 }),
  }));
  return <><Header title="Job controls" description="Explicit worker operations. Movement selection lists the latest 200 events. Loading this page never calls a provider." />{status && <Note>{status === "cancellation-requested" ? "Cancellation requested. In-flight calls may already have completed; stored evidence is retained." : "Request could not be applied. Validate the payload or refresh the current job state."}</Note>}
  <Panel title="Queue an operation">{!options.ok ? <Unavailable /> : <OperationForm requestId={randomUUID()} date={marketDate(new Date())} stocks={options.data.stocks} sources={options.data.sources} movements={options.data.movements.map((m) => ({ id: m.id, label: `${m.instrument.symbol} · ${m.observedAt.toISOString()} · ${m.priceChangePct?.toFixed(2) ?? "?"}%` }))} />}</Panel>
  {!jobs.ok ? <Unavailable /> : <Panel title="Recent operations">{jobs.data.length ? jobs.data.map((job) => <article key={job.id}><p><Link href={`/system/jobs/${job.id}`}>{job.kind}</Link> · {job.status} · {time(job.createdAt)}</p>{["pending", "retry", "running"].includes(job.status) && <form action={cancelJob}><input type="hidden" name="id" value={job.id} /><label><input type="checkbox" name="confirm" value="yes" required /> Confirm cancellation</label><button className="button secondary" disabled={Boolean(job.cancelRequestedAt)}>{job.cancelRequestedAt ? "Cancellation pending" : "Cancel operation"}</button></form>}</article>) : <p>No operations queued.</p>}</Panel>}{jobs.ok && <Pagination page={page} hasNext={jobs.data.length === 100} base="/system/controls" />}</>;
}
