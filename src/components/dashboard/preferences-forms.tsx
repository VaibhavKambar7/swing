"use client";
import { useActionState } from "react";
import { updatePreferences, updateWatchlist } from "@/app/(workspace)/preferences-actions";
import type { AlertPreferences } from "@/lib/dashboard/preferences";
const initial = { ok: false, message: "" };
const options: [keyof AlertPreferences, string, string][] = [
  ["announcementsEnabled", "Announcements", "Company filings with a selected research priority."],
  ["movementsEnabled", "Price movements", "Recorded movement signals with a selected research priority."],
  ["briefingsEnabled", "Daily briefings", "Morning and closing reports, including post-open updates."],
  ["investigateEnabled", "Investigate", "Items marked for further investigation."],
  ["watchEnabled", "Watch", "Items marked for observation."],
  ["unassessedEnabled", "Unassessed", "Include items without a stored research classification."],
  ["watchlistOnly", "Watched stocks only", "Limit research alerts to your watchlist. Daily briefings remain market-wide."],
];
export function PreferencesForm({ preferences }: { preferences: AlertPreferences }) {
  const [result, action, pending] = useActionState(updatePreferences, initial);
  return <form action={action} className="settings-form"><fieldset disabled={pending}><legend className="sr-only">Frontend alert preferences</legend>
    {options.map(([key, title, detail]) => <label className="setting-option" key={key}><input type="checkbox" name={key} defaultChecked={preferences[key]} /><span><strong>{title}</strong><span>{detail}</span></span></label>)}
    </fieldset><div className="form-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save preferences"}</button><span role="status" className={result.ok ? "muted" : "action-error"}>{result.message}</span></div></form>;
}
export function WatchlistForm({ stocks, instrumentId }: { stocks?: { id: string; symbol: string; exchange: string }[]; instrumentId?: string }) {
  const [result, action, pending] = useActionState(updateWatchlist, initial);
  return <form action={action} className="watchlist-form"><input type="hidden" name="operation" value={instrumentId ? "remove" : "add"} />
    {instrumentId ? <input type="hidden" name="instrumentId" value={instrumentId} /> : <label>Stock<select name="instrumentId" required defaultValue=""><option value="" disabled>Select a stock</option>{stocks?.map((stock) => <option key={stock.id} value={stock.id}>{stock.exchange} · {stock.symbol}</option>)}</select></label>}
    <button className={`button ${instrumentId ? "secondary" : "primary"}`} type="submit" disabled={pending || (!instrumentId && !stocks?.length)}>{pending ? "Saving…" : instrumentId ? "Remove" : "Add to watchlist"}</button>
    <span role="status" className={result.ok ? "muted" : "action-error"}>{result.message}</span></form>;
}
