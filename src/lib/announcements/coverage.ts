import { NSE_SOURCE } from "./rss";
// Historical/unknown publishers remain in the raw inbox but are not promoted as
// official or configured news evidence by a coincidental issuer-like headline.
export const supportedFeedWhere = { OR: [{ source: NSE_SOURCE }, { source: "bse-announcements" }, { source: { startsWith: "news-search:" } }] };
