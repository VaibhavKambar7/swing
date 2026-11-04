import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { getFrontendAlerts, alertFiltersSchema } from "@/lib/dashboard/alerts";
import { loadRead } from "@/lib/dashboard/queries";
import { Badge, Empty, Header, Note, Panel, time, Unavailable } from "@/components/dashboard/components";
export default async function Alerts({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parsed = alertFiltersSchema.safeParse(await searchParams);
  if (!parsed.success) return <><Header title="Alerts" description="Your frontend alert feed." /><Empty title="Invalid filters"><Link href="/alerts">Reset filters</Link></Empty></>;
  const filters = parsed.data;
  const loaded = await loadRead(() => getFrontendAlerts(getDatabase(), filters));
  const pageUrl = (page: number) => `/alerts?${new URLSearchParams({ read: filters.read, page: String(page) })}`;
  return <><Header title="Alerts" description="Research and reports selected by your saved preferences." />
    <form className="filter-bar" method="GET" action="/alerts"><label>Review state<select name="read" defaultValue={filters.read}><option value="all">All alerts</option><option value="unread">Unread</option><option value="read">Read</option></select></label><button className="button primary" type="submit">Apply</button><Link className="text-link" href="/settings">Alert preferences ↗</Link></form>
    {!loaded.ok ? <Unavailable /> : <Panel title={`${loaded.data.total} alerts`} subtitle={`${loaded.data.unread} unread across your selected categories`}>
      {loaded.data.items.length ? <div className="table-scroll"><table><thead><tr><th>Stock / type</th><th>Alert</th><th>Priority</th><th>Recorded</th></tr></thead><tbody>{loaded.data.items.map((item) => <tr key={`${item.kind}:${item.id}`} className={item.isRead ? "" : "unread-row"}><td className="stock-symbol">{item.symbol ?? (item.kind === "briefing" ? "Daily report" : "Unmatched")}</td><td className="title-cell">{!item.isRead && <span className="review-label unread">Unread</span>}<Link className="item-title" href={item.kind === "briefing" ? `/briefings/${item.id}` : `/inbox/${item.kind}/${item.id}`}>{item.title}</Link>{item.summary && <p className="row-summary">{item.summary}</p>}</td><td>{item.kind === "briefing" ? <Badge value="unknown" label="Report" /> : <Badge value={item.classification} />}</td><td className="time-cell">{time(item.recordedAt)}</td></tr>)}</tbody></table></div> : <Empty title="No alerts match this view">Change your preferences or check the full <Link href="/inbox">research inbox</Link>. If you selected watched stocks only, add stocks to your <Link href="/watchlist">watchlist</Link>.</Empty>}
      <div className="pagination"><span>Page {filters.page} · up to 25 alerts</span><div>{filters.page > 1 && <Link className="button secondary" href={pageUrl(filters.page - 1)}>← Previous</Link>}{filters.page * 25 < loaded.data.total && filters.page < 200 && <Link className="button secondary" href={pageUrl(filters.page + 1)}>Next →</Link>}</div></div></Panel>}
    <Note>Alerts appear from stored records when you load or refresh. Preferences affect this feed; they do not delete source records or stop background research. Email and Telegram are not used.</Note></>;
}
