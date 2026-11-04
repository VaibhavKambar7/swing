import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { getResearchOutcomes } from "@/lib/dashboard/outcomes";
import { loadRead } from "@/lib/dashboard/queries";
import { Badge, Empty, Header, Metric, Note, Panel, time, Unavailable } from "@/components/dashboard/components";
export default async function Outcomes() {
  const loaded = await loadRead(() => getResearchOutcomes(getDatabase()));
  return <><Header title="Research follow-ups" description="Observed price changes after research, with missing-data states preserved." />
    {!loaded.ok ? <Unavailable /> : <><div className="metrics-grid"><Metric label="Pending" value={loaded.data.pending} note="Horizon, reference, or calendar coverage pending" /><Metric label="Observed" value={loaded.data.measured} note="Unverified source-price changes" /><Metric label="Unavailable" value={loaded.data.unavailable} note="Required observations were not captured" /></div>
    <Panel title="Recent follow-ups" subtitle="Latest 50 updates · 1, 5 and 20 later trading-session closes">{loaded.data.items.length ? <div className="table-scroll"><table><thead><tr><th>Research / horizon</th><th>State</th><th>Reference</th><th>Later observation</th><th>Change</th></tr></thead><tbody>{loaded.data.items.map((item) => {
      const filing = item.feedResearch?.feedItem;
      const symbol = filing?.instrument?.symbol ?? item.analysis?.signal.instrument.symbol ?? "Unmatched";
      const href = filing ? `/inbox/announcement/${filing.id}` : `/inbox/movement/${item.analysis!.signal.id}`;
      return <tr key={item.id}><td><Link className="item-title" href={href}>{symbol} · {item.horizonSessions} sessions</Link><span className="cell-caption">Research: {time(item.feedResearch?.createdAt ?? item.analysis?.createdAt)}</span><span className="cell-caption">{item.referenceSnapshot?.provider ?? "No reference provider"}</span></td><td><Badge value={item.status === "measured" ? "keep" : "unknown"} label={item.status} /><span className="cell-caption">{item.reason.replaceAll("_", " ")}</span></td><td className="time-cell">{item.referencePrice?.toString() ?? "Missing"}<span className="cell-caption">{time(item.referenceAt)}</span></td><td className="time-cell">{item.observedPrice?.toString() ?? "Missing"}<span className="cell-caption">{time(item.observedAt)}</span><span className="cell-caption">Due: {time(item.dueAt)}</span></td><td>{item.changePct ? `${item.changePct.toFixed(2)}%` : "Unavailable"}</td></tr>;
    })}</tbody></table></div> : <Empty title="No follow-ups recorded">The follow-up job creates records for stored Investigate / Watch research. Opening this page does not run it.</Empty>}</Panel></>}
    <Note>Reference is the first eligible quote captured within 15 minutes after research during an open session, or after the next session opens. Later observations come from the final 15 minutes of the 1st, 5th, or 20th following trading day. These are provider-native price changes with unknown distribution delay, not verified returns. Splits, dividends, fees, entry/exit execution, benchmarks, and causality are not accounted for.</Note></>;
}
