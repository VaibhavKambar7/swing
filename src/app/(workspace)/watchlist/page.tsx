import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { getWatchlist } from "@/lib/dashboard/preferences";
import { loadRead } from "@/lib/dashboard/queries";
import { Empty, Header, Note, Panel, Unavailable } from "@/components/dashboard/components";
import { WatchlistForm } from "@/components/dashboard/preferences-forms";
export default async function Watchlist() {
  const loaded = await loadRead(async () => {
    const db = getDatabase();
    const [entries, stocks] = await Promise.all([getWatchlist(db), db.instrument.findMany({ where: { active: true, inUniverse: true, kind: "equity" }, orderBy: [{ symbol: "asc" }, { id: "asc" }], take: 2000, select: { id: true, symbol: true, exchange: true } })]);
    return { entries, stocks };
  });
  return <><Header title="Your watchlist" description="Choose the stocks you want to follow more closely." />
    {!loaded.ok ? <Unavailable /> : <><Panel title="Follow a stock" subtitle="Choose from the configured research universe"><div className="settings-form"><WatchlistForm stocks={loaded.data.stocks.filter((s) => !loaded.data.entries.some((e) => e.instrumentId === s.id))} /></div></Panel>
    <Panel title={`${loaded.data.entries.length} watched stocks`}>{loaded.data.entries.length ? <div className="table-scroll"><table><thead><tr><th>Stock</th><th>Company</th><th>Coverage</th><th /></tr></thead><tbody>{loaded.data.entries.map((entry) => <tr key={entry.instrumentId}><td><Link className="item-title" href={`/inbox?stock=${encodeURIComponent(entry.instrument.symbol)}`}>{entry.instrument.symbol}</Link><span className="cell-caption">{entry.instrument.exchange}</span></td><td>{entry.instrument.name}</td><td>{entry.instrument.active && entry.instrument.inUniverse ? "In research universe" : "Outside active coverage"}</td><td><WatchlistForm instrumentId={entry.instrumentId} /></td></tr>)}</tbody></table></div> : <Empty title="No watched stocks yet">Add a stock above. Your full research inbox remains available.</Empty>}</Panel></>}
    <Note>Watching a stock does not change market-data coverage. Enable “Watched stocks only” in <Link href="/settings">alert preferences</Link> to focus frontend alerts on this list.</Note></>;
}
