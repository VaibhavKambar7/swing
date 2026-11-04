import { supportedFeedWhere } from "./coverage";
import type { PrismaClient } from "../../generated/prisma/client";

type MatchInstrument = { id: string; symbol: string; name: string; bseCode?: string | null };
export type StockMatch =
  | { status: "matched"; instrumentId: string }
  | { status: "unmatched" | "ambiguous"; instrumentId: null };

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .replace(/\bltd\b/g, "limited");
}

function withoutLegalSuffix(value: string) {
  return value.replace(/ limited$/, "");
}

export function matchAnnouncement(title: string, instruments: MatchInstrument[]): StockMatch {
  // NSE issuer headings usually use "Company - Subject". Restrict matching to
  // this heading: a company mentioned in the body is not necessarily the issuer.
  const issuer = normalize(title.replace(/^\s*NSE\s*:\s*/i, "").split(/\s+[-–—]\s+|[:|]/, 1)[0]);
  if (!issuer) return { status: "unmatched", instrumentId: null };
  const candidates = instruments.filter((instrument) => {
    const name = normalize(instrument.name);
    return issuer === normalize(instrument.symbol) || issuer === name ||
      withoutLegalSuffix(issuer) === withoutLegalSuffix(name);
  });
  const ids = [...new Set(candidates.map((candidate) => candidate.id))];
  if (ids.length === 1) return { status: "matched", instrumentId: ids[0] };
  return { status: ids.length ? "ambiguous" : "unmatched", instrumentId: null };
}

export async function matchStoredAnnouncements(db: PrismaClient) {
  const instruments = await db.instrument.findMany({
    where: { exchange: "NSE", kind: "equity", active: true, inUniverse: true },
    select: { id: true, symbol: true, name: true, bseCode: true },
  });
  if (!instruments.length) throw new Error("No active NSE stocks in the universe; seed or configure stocks first");
  const counts = { matched: 0, unmatched: 0, ambiguous: 0 };
  let cursor: string | undefined;
  while (true) {
    const items = await db.feedItem.findMany({
      where: { AND: [supportedFeedWhere], matchStatus: { not: "matched" }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: 100, select: { id: true, title: true, source: true, issuerCode: true },
    });
    if (!items.length) break;
    for (const item of items) {
      const codes = item.issuerCode ? instruments.filter((i) => i.bseCode === item.issuerCode) : [];
      const newsCandidates = item.source.startsWith("news-search:") ? instruments.filter((i) => {
        const title = ` ${normalize(item.title)} `;
        const escaped = i.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return title.includes(` ${normalize(i.name)} `) || (i.symbol.length >= 3 && new RegExp(`(?:^|[^A-Za-z0-9&-])${escaped}(?=$|[^A-Za-z0-9&-])`).test(item.title));
      }) : [];
      const candidates = item.issuerCode ? codes : item.source.startsWith("news-search:") ? newsCandidates : null;
      const match: StockMatch = candidates ? candidates.length === 1 ? { status: "matched", instrumentId: candidates[0].id } : { status: candidates.length ? "ambiguous" : "unmatched", instrumentId: null } : matchAnnouncement(item.title, instruments);
      const result = await db.feedItem.updateMany({
        // A concurrent run must not overwrite an already established match.
        where: { id: item.id, matchStatus: { not: "matched" } },
        data: { matchStatus: match.status, instrumentId: match.instrumentId, matchCheckedAt: new Date() },
      });
      counts[match.status] += result.count;
    }
    cursor = items[items.length - 1].id;
  }
  return counts;
}
