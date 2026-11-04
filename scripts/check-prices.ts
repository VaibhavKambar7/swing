import "../src/lib/config/load-env";
import { MarketDataError, parsePriceArgs } from "../src/lib/market-data/provider";
import { createMarketProvider } from "../src/lib/market-data/registry";

async function main() {
  try {
    const { instrument, days } = parsePriceArgs(process.argv.slice(2));
    const snapshot = await createMarketProvider().getSnapshot(instrument, days);
    console.log(JSON.stringify({ event: "market_data_checked", input: "live", ...snapshot }));
    if (!snapshot.quote) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "market_data_failed", code: error instanceof MarketDataError ? error.code : "MARKET_DATA_UNAVAILABLE", httpStatus: error instanceof MarketDataError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  }
}
void main();
