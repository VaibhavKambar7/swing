import { z } from "zod";
import type { PrismaClient, FeedSource } from "../../generated/prisma/client";
import { AnnouncementFeedError, fetchAnnouncements, NSE_SOURCE, type FeedEntry } from "./rss";
import { storeAnnouncements } from "./ingest";
const bseRow = z.object({ NEWSID: z.string(), SCRIP_CD: z.union([z.string(), z.number()]), NEWSSUB: z.string(), SLONGNAME: z.string().optional(), DT_TM: z.string().optional(), ATTACHMENTNAME: z.string().nullable().optional(), MORE: z.string().nullable().optional() });
export function parseBse(body: unknown): FeedEntry[] {
  const rows = z.object({ Table: z.array(bseRow).max(1000) }).safeParse(body);
  if (!rows.success) throw new AnnouncementFeedError("invalid_bse_response", "BSE response format not recognized");
  return rows.data.Table.map((r) => {
    // BSE timestamps without an explicit offset are exchange-local, never host-local.
    const raw = r.DT_TM?.trim();
    const normalized = raw?.replace(" ", "T");
    const date = normalized ? new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}+05:30`) : null;
    const attachment = r.ATTACHMENTNAME && /^[a-zA-Z0-9_.-]+\.pdf$/i.test(r.ATTACHMENTNAME) ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${r.ATTACHMENTNAME}` : `https://www.bseindia.com/stock-share-price/stockreach_financials.aspx?scripcode=${encodeURIComponent(String(r.SCRIP_CD))}`;
    return { sourceId: r.NEWSID, issuerCode: String(r.SCRIP_CD), title: r.NEWSSUB, url: attachment, description: r.MORE ?? null, publishedAt: date && Number.isFinite(date.getTime()) ? date : null };
  });
}
export interface AnnouncementSourceAdapter { fetch(source: FeedSource, signal?: AbortSignal): Promise<{ items: FeedEntry[]; skipped: number }> }
export function createSourceAdapter(fetcher: typeof fetch = fetch, clock = () => new Date()): AnnouncementSourceAdapter {
  return { async fetch(source, signal) {
    if (source.kind === "nse") return fetchAnnouncements(fetcher, undefined, signal);
    if (source.kind === "news-search") {
      if (!source.query || source.query.length > 300) throw new AnnouncementFeedError("source_configuration_required", "Configure a search query");
      const url = new URL("https://news.google.com/rss/search");
      url.search = new URLSearchParams({ q: source.query, hl: "en-IN", gl: "IN", ceid: "IN:en" }).toString();
      return fetchAnnouncements(fetcher, url.href, signal);
    }
    if (source.kind !== "bse") throw new AnnouncementFeedError("unsupported_source", "Unsupported source kind");
    const date = new Date(clock().getTime() + 19800000).toISOString().slice(0, 10).replaceAll("-", "");
    const items: FeedEntry[] = [];
    for (let page = 1; page <= 5; page++) {
      signal?.throwIfAborted();
      const url = new URL("https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w");
      url.search = new URLSearchParams({ strCat: "-1", strPrevDate: date, strScrip: "", strSearch: "P", strToDate: date, strType: "C", subcategory: "-1", strPageNo: String(page) }).toString();
      try {
        const response = await fetcher(url, { headers: { Accept: "application/json", Referer: "https://www.bseindia.com/" }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
        if (!response.ok) { await response.body?.cancel(); throw new AnnouncementFeedError("bse_http_error", "BSE request failed", response.status); }
        const reader = response.body?.getReader(); if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 5 * 1024 * 1024) throw new AnnouncementFeedError("response_too_large", "BSE response exceeds limit"); chunks.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
        const pageItems = parseBse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        items.push(...pageItems); if (!pageItems.length) return { items, skipped: 0 };
      } catch (e) { if (e instanceof AnnouncementFeedError) throw e; throw new AnnouncementFeedError("bse_network_or_format_error", "BSE access or format failed"); }
    }
    // Bounded window is explicit; never claim this is complete historical coverage.
    return { items, skipped: 0 };
  } };
}
export function sourceNamespace(source: FeedSource) { return source.kind === "nse" ? NSE_SOURCE : source.kind === "bse" ? "bse-announcements" : `news-search:${source.id}`; }
export async function collectSource(db: PrismaClient, id: string, signal?: AbortSignal, adapter = createSourceAdapter()) {
  const source = await db.feedSource.findUnique({ where: { id } });
  if (!source?.enabled) throw new AnnouncementFeedError("source_disabled", "Source is missing or disabled");
  const key = { source: "feed-source", scope: id };
  await db.pollingCheckpoint.upsert({ where: { source_scope: key }, create: { ...key, lastAttemptAt: new Date() }, update: { lastAttemptAt: new Date() } });
  try {
    const feed = await adapter.fetch(source, signal); signal?.throwIfAborted();
    const stored = await storeAnnouncements(db, feed.items, sourceNamespace(source));
    await db.pollingCheckpoint.update({ where: { source_scope: key }, data: { lastSuccessAt: new Date(), lastErrorCode: null, updatedAt: new Date(), cursor: { ...stored, skipped: feed.skipped, coverage: source.kind === "bse" ? "Current IST day, at most five pages; completeness unverified" : "Rolling source window; completeness unverified" } } });
    return stored;
  } catch (error) {
    await db.pollingCheckpoint.update({ where: { source_scope: key }, data: { lastErrorCode: error instanceof AnnouncementFeedError ? error.code : "SOURCE_COLLECTION_FAILED", updatedAt: new Date() } });
    throw error;
  }
}
export async function collectEnabledSources(db: PrismaClient) {
  const sources = await db.feedSource.findMany({ where: { enabled: true }, orderBy: { id: "asc" } });
  let received = 0, inserted = 0, duplicates = 0, failed = 0;
  for (const source of sources) { try { const result = await collectSource(db, source.id); received += result.received; inserted += result.inserted; duplicates += result.duplicates; } catch { failed++; } }
  return { received, inserted, duplicates, failed };
}
