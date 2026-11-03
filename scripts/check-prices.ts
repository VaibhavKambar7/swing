import "../src/lib/config/load-env";
import { MarketDataError, validateHistoryDays } from "../src/lib/market-data/provider";
import { createYahooProvider } from "../src/lib/market-data/yahoo";

async function main() {
  try {
    const [symbol, flag, value, ...extra] = process.argv.slice(2);
    if (!symbol || extra.length || (flag !== undefined && (flag !== "--days" || !value || !/^\d+$/.test(value)))) throw new MarketDataError("INVALID_ARGUMENTS");
    const days = value === undefined ? 30 : Number(value);
    validateHistoryDays(days);
    const snapshot = await createYahooProvider().getSnapshot({ exchange: "NSE", symbol }, days);
    console.log(JSON.stringify({ event: "market_data_checked", input: "live", ...snapshot }));
    if (!snapshot.quote) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "market_data_failed", code: error instanceof MarketDataError ? error.code : "MARKET_DATA_UNAVAILABLE", httpStatus: error instanceof MarketDataError ? error.httpStatus : undefined }));
    process.exitCode = 1;
  }
}
void main();
