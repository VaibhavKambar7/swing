import { XMLParser, XMLValidator } from "fast-xml-parser";

export const NSE_ANNOUNCEMENTS_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml";
export const NSE_SOURCE = "nse-announcements-rss";

export type FeedEntry = {
  sourceId: string;
  title: string;
  url: string;
  description: string | null;
  publishedAt: Date | null;
};

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  // Only built-in XML entities are needed; reject DTDs before parsing.
  processEntities: true,
  isArray: (name) => name === "item",
});

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseAnnouncements(xml: string): { items: FeedEntry[]; skipped: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid announcement RSS XML");
  }
  const document = parser.parse(xml);
  const channel = document?.rss?.channel;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    throw new Error("Expected an RSS channel");
  }
  const rows: unknown[] = channel.item ?? [];
  const items: FeedEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    const item = row as Record<string, unknown> | null;
    const title = text(item?.title);
    const link = text(item?.link);
    const url = URL.parse(link);
    if (!title || !url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      skipped++;
      continue;
    }
    const date = text(item?.pubDate);
    const publishedAt = date ? new Date(date) : null;
    items.push({
      sourceId: text(item?.guid) || url.href,
      title,
      url: url.href,
      description: text(item?.description) || null,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  return { items, skipped };
}

export async function fetchAnnouncements(fetcher: typeof fetch = fetch) {
  const response = await fetcher(NSE_ANNOUNCEMENTS_URL, {
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Announcement feed returned HTTP ${response.status}`);
  // Read incrementally so an unexpected response cannot fill memory.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Announcement feed returned an empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 5 * 1024 * 1024) throw new Error("Announcement feed exceeds 5 MB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return parseAnnouncements(Buffer.concat(chunks).toString("utf8"));
}
