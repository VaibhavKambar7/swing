import "../src/lib/config/load-env";
import { BriefingError, generateMorningBriefing } from "../src/lib/briefings/morning";
import { loadMarketCalendar } from "../src/lib/market/load-calendar";
import { CalendarError } from "../src/lib/market/calendar";
import { closeDatabase, getDatabase } from "../src/lib/db";

async function main() {
  try {
    const args = process.argv.slice(2);
    let date: string | undefined;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--json" && !json) json = true;
      else if (args[i] === "--date" && !date && args[i + 1] && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1])) date = args[++i];
      else throw new BriefingError("INVALID_ARGUMENTS");
    }
    const result = await generateMorningBriefing(getDatabase(), await loadMarketCalendar(), date);
    console.log(json ? JSON.stringify({ event: "morning_briefing", ...result }) : result.report.markdown);
  } catch (error) {
    console.error(JSON.stringify({ event: "morning_briefing_failed", code: error instanceof BriefingError || error instanceof CalendarError ? error.code : "BRIEFING_UNAVAILABLE" }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
