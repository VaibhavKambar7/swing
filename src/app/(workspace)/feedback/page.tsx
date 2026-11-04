import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { getFeedbackOverview } from "@/lib/dashboard/feedback";
import { loadRead } from "@/lib/dashboard/queries";
import { Badge, Empty, Header, Metric, Note, Panel, time, Unavailable } from "@/components/dashboard/components";
export default async function Feedback() {
  const loaded = await loadRead(() => getFeedbackOverview(getDatabase()));
  return <><Header title="Feedback" description="Review which research versions and reports you found useful." />
    {!loaded.ok ? <Unavailable /> : <><div className="metrics-grid"><Metric label="Useful" value={loaded.data.useful} note="Saved choices across reviewed versions" accent /><Metric label="Not useful" value={loaded.data.notUseful} note="Saved choices across reviewed versions" /></div>
    <Panel title="Recent feedback" subtitle="Latest 50 choices; links open the item’s current version">{loaded.data.recent.length ? <div className="table-scroll"><table><thead><tr><th>Item</th><th>Choice</th><th>Note</th><th>Updated</th></tr></thead><tbody>{loaded.data.recent.map((entry) => {
      const href = entry.feedItem ? `/inbox/announcement/${entry.feedItem.id}` : entry.signal ? `/inbox/movement/${entry.signal.id}` : `/briefings/${entry.dailyBriefing!.id}`;
      const title = entry.feedItem?.title ?? (entry.signal ? `${entry.signal.instrument.symbol} · price movement` : `${entry.dailyBriefing!.kind} report · ${entry.dailyBriefing!.sessionDate.toISOString().slice(0, 10)}`);
      return <tr key={entry.id}><td><Link className="item-title" href={href}>{title}</Link><span className="cell-caption">Reviewed version: {entry.contentVersion}</span></td><td><Badge value={entry.useful ? "keep" : "unknown"} label={entry.useful ? "Useful" : "Not useful"} /></td><td className="reason-cell">{entry.reason ?? "No note"}</td><td className="time-cell">{time(entry.updatedAt)}</td></tr>;
    })}</tbody></table></div> : <Empty title="No feedback yet">Use the Useful / Not useful controls on a research item or report.</Empty>}</Panel></>}
    <Note>Feedback records your judgment. It does not measure investment performance, change research classifications, or train a model automatically.</Note></>;
}
