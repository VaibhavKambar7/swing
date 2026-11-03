import "../src/lib/config/load-env";
import { detectStoredMovement } from "../src/lib/market-data/detect";
import { MarketDataError } from "../src/lib/market-data/provider";
import { loadMarketCalendar } from "../src/lib/market/load-calendar";
import { CalendarError } from "../src/lib/market/calendar";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    const [symbol, ...extra] = process.argv.slice(2);
    if (!symbol || extra.length) throw new MarketDataError("INVALID_ARGUMENTS");
    const calendar = await loadMarketCalendar();
    const result = await detectStoredMovement(getDatabase(), calendar, { exchange: "NSE", symbol });
    console.log(JSON.stringify({ event: "movement_detection", symbol: symbol.trim().toUpperCase(), ...result }));
    if (result.status === "skipped" && result.reason === "CALENDAR_COVERAGE_REQUIRED") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "movement_detection_failed", code: error instanceof MarketDataError || error instanceof CalendarError ? error.code : "MOVEMENT_STORAGE_UNAVAILABLE" }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
