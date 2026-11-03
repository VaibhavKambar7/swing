import "../src/lib/config/load-env";
import { reassessMorningWatchlist } from "../src/lib/briefings/post-open";
import { BriefingError } from "../src/lib/briefings/morning";
import { loadMarketCalendar } from "../src/lib/market/load-calendar";
import { CalendarError } from "../src/lib/market/calendar";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    if (process.argv.length > 2) throw new BriefingError("INVALID_ARGUMENTS");
    const result = await reassessMorningWatchlist(getDatabase(), await loadMarketCalendar());
    console.log(JSON.stringify({ event: "post_open_reassessment", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "post_open_failed", code: error instanceof BriefingError || error instanceof CalendarError ? error.code : "REASSESSMENT_UNAVAILABLE" }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
