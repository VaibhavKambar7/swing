import { Pagination, pageNumber } from "@/components/dashboard/pagination";
import { FeedbackForm } from "@/components/dashboard/feedback-form";
import { ReadToggle } from "@/components/dashboard/read-toggle";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { getDatabase } from "@/lib/db";
import { getReport, loadRead, safeSourceUrl, stringList } from "@/lib/dashboard/queries";
import { Badge, DefinitionList, Header, Note, Panel, time, Unavailable } from "@/components/dashboard/components";
export default async function Report({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const page = pageNumber((await searchParams).page);
  const loaded = await loadRead(() => getReport(getDatabase(), id, page));
  if (!loaded.ok) return <><Header title="Stored report" description="Original briefing and its recorded assessment history." /><Unavailable /></>;
  const report = loaded.data;
  if (!report) notFound();
  const content = report.content && typeof report.content === "object" && !Array.isArray(report.content) ? report.content as Record<string, unknown> : {};
  return <><Link className="back-link" href="/briefings">← Back to briefings</Link><Header eyebrow={`${report.sessionDate.toISOString().slice(0, 10)} · ${report.reportVersion}`} title={report.kind === "morning" ? "Morning briefing" : report.kind === "closing" ? "Preliminary closing summary" : "Stored report"} description={`Information cutoff ${time(report.cutoffAt)}`} />
  {page === 1 && <><ReadToggle key={`${report.id}:${report.readVersion}:${report.isRead}`} kind="briefing" id={report.id} version={report.readVersion} isRead={report.isRead} />
  <Panel title="Your feedback" subtitle="Saved for this reviewed version; it does not alter the assessment"><FeedbackForm key={`${report.id}:${report.readVersion}:${report.feedback?.useful}`} kind="briefing" id={report.id} version={report.readVersion} feedback={report.feedback} /></Panel></>}
  <div className="detail-grid"><Panel title="Original briefing" subtitle="Stored report content; viewing does not regenerate it"><div className="report-markdown"><ReactMarkdown skipHtml urlTransform={(url) => safeSourceUrl(url) ?? ""} components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a> : <span>{children}</span> }}>{report.markdown}</ReactMarkdown></div></Panel><div><Panel title="Report metadata"><DefinitionList values={{ "Session": report.sessionDate.toISOString().slice(0, 10), "Version": report.reportVersion, "Window begins": time(report.windowStart), "Information cutoff": time(report.cutoffAt), "Generated": time(report.generatedAt) }} /></Panel><Panel title="Coverage notes"><div className="source-text">{stringList(content.limitations).length ? <ul>{stringList(content.limitations).map((note, i) => <li key={i}>{note}</li>)}</ul> : <p>No structured coverage notes stored. Review the report for limitations.</p>}</div></Panel></div></div>
  <Panel title="Post-open assessment history" subtitle="100 stored revisions per page; timestamps identify the original evaluation">{report.postOpenAssessments.length ? <div className="table-scroll"><table><thead><tr><th>Stock</th><th>State</th><th>Reason</th><th>Assessed</th></tr></thead><tbody>{report.postOpenAssessments.map((assessment) => <tr key={assessment.id}><td className="stock-symbol">{assessment.instrument.symbol}</td><td><Badge value={assessment.status} /></td><td className="reason-cell">{assessment.reason.replaceAll("_", " ")}</td><td className="time-cell">{time(assessment.assessedAt)}</td></tr>)}</tbody></table></div> : <div className="empty-inline"><p>No post-open assessments are linked to this report.</p></div>}</Panel><Pagination page={page} hasNext={report.postOpenAssessments.length === 100} base={`/briefings/${id}`} /><Note>Price availability, source delays, and information gaps remain as recorded in the original report.</Note></>;
}
