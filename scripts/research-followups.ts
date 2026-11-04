import "../src/lib/config/load-env";
import { getDatabase, closeDatabase } from "../src/lib/db";
import { loadMarketCalendar } from "../src/lib/market/load-calendar";
import { CalendarError } from "../src/lib/market/calendar";
import { updateResearchFollowUps } from "../src/lib/research/followups";
async function main() {
  try {
    if (process.argv.length !== 2) throw new Error("Invalid arguments");
    const result = await updateResearchFollowUps(getDatabase(), await loadMarketCalendar());
    console.log(JSON.stringify({ event: "research_followups_updated", ...result }));
  } catch (error) { console.error(JSON.stringify({ event: "research_followups_failed", code: error instanceof CalendarError ? error.code : "FOLLOWUPS_UNAVAILABLE" })); process.exitCode = 1; }
  finally { await closeDatabase(); }
}
void main();
