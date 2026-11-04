import { createYahooProvider } from "./yahoo";
import { MarketDataError, type MarketDataProvider } from "./provider";
// The worker, manual imports and detector consume the same adapter contract.
// Kite is an explicit configuration error until its separately deferred adapter exists.
export function createMarketProvider(name = process.env.MARKET_DATA_PROVIDER ?? "yahoo-experimental"): MarketDataProvider {
  if (name === "yahoo-experimental") return createYahooProvider();
  throw new MarketDataError(name === "kite" ? "KITE_INTEGRATION_DEFERRED" : "MARKET_PROVIDER_NOT_CONFIGURED");
}
