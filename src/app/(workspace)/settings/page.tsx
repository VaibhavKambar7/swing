import { getDatabase } from "@/lib/db";
import { getPreferences } from "@/lib/dashboard/preferences";
import { loadRead } from "@/lib/dashboard/queries";
import { Header, Note, Panel, Unavailable } from "@/components/dashboard/components";
import { PreferencesForm } from "@/components/dashboard/preferences-forms";
export default async function Settings() {
  const loaded = await loadRead(() => getPreferences(getDatabase()));
  return <><Header title="Alert preferences" description="Choose what belongs in your frontend alert feed." />
    {!loaded.ok ? <Unavailable /> : <Panel title="Frontend alerts" subtitle="These settings are saved for your personal workspace"><PreferencesForm preferences={loaded.data} /></Panel>}
    <Note>Preferences control the alert feed. All source records remain available in the research inbox. Ignored and routine filings are retained for review. Daily briefings cover the wider market.</Note></>;
}
