import { SubmitButton } from "@/components/dashboard/submit-button";
import { getDatabase } from "@/lib/db";
import { loadRead } from "@/lib/dashboard/queries";
import { Header, Note, Panel, Unavailable, time } from "@/components/dashboard/components";
import { saveSource, toggleSource } from "./actions";
export default async function Sources({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const loaded = await loadRead(async () => ({ sources: await getDatabase().feedSource.findMany({ orderBy: { name: "asc" } }), checks: await getDatabase().pollingCheckpoint.findMany({ where: { source: "feed-source" } }) }));
  return <><Header title="Announcement and news sources" description="Configure independent source coverage. Collection stores original evidence before matching or AI." />{status && <Note>{status === "saved" ? "Source configuration saved." : "Save failed. Check fields and database; at most 20 sources are supported."}</Note>}
    {!loaded.ok ? <Unavailable /> : <Panel title="Configured sources">{loaded.data.sources.map((s) => { const check = loaded.data.checks.find((c) => c.scope === s.id); return <article key={s.id}><h3>{s.name}</h3><p>{s.kind} · {s.enabled ? "Enabled" : "Disabled"} · {s.query}</p><p>Last attempt: {time(check?.lastAttemptAt)} · success: {time(check?.lastSuccessAt)} · error: {check?.lastErrorCode ?? "None recorded"}</p><form action={toggleSource}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} /><SubmitButton secondary>{s.enabled ? "Disable" : "Enable"}</SubmitButton></form></article>; })}</Panel>}
    <Panel title="Add external news search"><form action={saveSource}><label>Name <input name="name" required maxLength={100} /></label><label>Google News RSS query <input name="query" required minLength={3} maxLength={300} /></label><SubmitButton>Add source</SubmitButton></form></Panel>
    <Note>NSE and BSE are official exchange sources; external news is unverified third-party reporting. News matching requires an unambiguous stock symbol or full name in the headline. BSE matches only configured six-digit scrip codes. Rolling feeds, BSE’s current-day five-page cap, and source access failures can leave gaps. Source configuration does not run collection; enable the scheduler or enqueue collection in Job controls. An unavailable source does not discard successful sources.</Note></>;
}
