import type { PrismaClient } from "../../generated/prisma/client";
import { rateLimitedFetch } from "../network/rate-limit";
import { createYahooProvider } from "./yahoo";
import { MarketDataError, type MarketDataProvider } from "./provider";
// The worker, manual imports and detector consume the same adapter contract.
// Kite is an explicit configuration error until its separately deferred adapter exists.
export function createMarketProvider(name = process.env.MARKET_DATA_PROVIDER ?? "yahoo-experimental", db?: PrismaClient): MarketDataProvider {
  const interval = Number(process.env.WORKER_PRICE_REQUEST_INTERVAL_MS ?? 1000);
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new MarketDataError("INVALID_RATE_LIMIT");
  if (name === "yahoo-experimental") return createYahooProvider(db ? rateLimitedFetch(db, fetch, interval) : fetch);
  throw new MarketDataError(name === "kite" ? "KITE_INTEGRATION_DEFERRED" : "MARKET_PROVIDER_NOT_CONFIGURED");
}
