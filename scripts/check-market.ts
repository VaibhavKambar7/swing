import "../src/lib/config/load-env";
import { CalendarError, getMarketState } from "../src/lib/market/calendar";
import { loadMarketCalendar, parseCalendarArgs } from "../src/lib/market/load-calendar";

async function main() {
  try {
    const options = parseCalendarArgs(process.argv.slice(2));
    const state = getMarketState(await loadMarketCalendar(options.file), options.at);
    console.log(JSON.stringify({ event: "market_calendar_checked", ...state }));
    if (state.status === "unknown") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "market_calendar_failed", code: error instanceof CalendarError ? error.code : "CALENDAR_CHECK_FAILED" }));
    process.exitCode = 1;
  }
}
void main();
