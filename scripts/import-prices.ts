import "../src/lib/config/load-env";
import { MarketDataError, parsePriceArgs } from "../src/lib/market-data/provider";
import { createYahooProvider } from "../src/lib/market-data/yahoo";
import { importMarketSnapshot } from "../src/lib/market-data/persist";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    const { instrument, days } = parsePriceArgs(process.argv.slice(2));
    const result = await importMarketSnapshot(getDatabase(), createYahooProvider(), instrument, days);
    console.log(JSON.stringify({ event: "market_data_imported", input: "live", symbol: instrument.symbol, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: "market_data_import_failed", code: error instanceof MarketDataError ? error.code : "MARKET_STORAGE_UNAVAILABLE", httpStatus: error instanceof MarketDataError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
void main();
