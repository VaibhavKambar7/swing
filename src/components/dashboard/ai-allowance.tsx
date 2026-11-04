import { getDatabase } from "@/lib/db";
import { getDailyAllowance } from "@/lib/research/allowance";
import { loadRead } from "@/lib/dashboard/queries";
import { DefinitionList, Note, Panel } from "./components";
export async function AiAllowance() {
  const loaded = await loadRead(() => getDailyAllowance(getDatabase()));
  return <Panel title="Daily AI allowance" subtitle="Shared by automatic research, manual requests, retries and fallback providers">
    {loaded.ok ? <DefinitionList values={{ "Day (IST)": loaded.data.day, "Validated responses": `${loaded.data.success} / ${loaded.data.limits.assessments}`, "Reserved / in progress": loaded.data.pending,
      "Reserved attempts": `${loaded.data.attempts} / ${loaded.data.limits.attempts}`, "Failed attempts": loaded.data.failed, "Additional requests available": loaded.data.remaining }} /> : <Note>AI usage could not be read. Check the database and required migrations; unavailable usage never means unlimited allowance.</Note>}
    <Note>Limits reset at midnight IST. Valid responses count before final storage. Failed calls and fallback calls consume attempts. Interrupted reservations remain counted for the day. This is a request-count limit, not a currency spending limit.</Note>
  </Panel>;
}
