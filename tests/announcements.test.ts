import { describe, expect, it, vi } from "vitest";
import { fetchAnnouncements, parseAnnouncements } from "../src/lib/announcements/rss";

const item = `<item><title><![CDATA[Example Ltd — Results & update]]></title>
  <link>https://example.com/filing?id=1&amp;type=results</link>
  <guid isPermaLink="false">000123</guid>
  <description><![CDATA[Quarterly <b>results</b>]]></description>
  <pubDate>Mon, 02 Nov 2026 08:45:00 +0530</pubDate></item>`;
const rss = (items: string) => `<rss version="2.0"><channel><title>Announcements</title>${items}</channel></rss>`;

describe("announcement RSS", () => {
  it("preserves source IDs, CDATA and source timestamps", () => {
    expect(parseAnnouncements(rss(item))).toEqual({ skipped: 0, items: [{
      sourceId: "000123", title: "Example Ltd — Results & update",
      url: "https://example.com/filing?id=1&type=results",
      description: "Quarterly <b>results</b>", publishedAt: new Date("2026-11-02T03:15:00Z"),
    }] });
  });
  it("accepts an empty feed and multiple items", () => {
    expect(parseAnnouncements(rss("")).items).toEqual([]);
    expect(parseAnnouncements(rss(item + item)).items).toHaveLength(2);
  });
  it("uses the link when no GUID exists and leaves missing dates unknown", () => {
    const result = parseAnnouncements(rss('<item><title>Update</title><link>https://example.com/1</link><pubDate>invalid</pubDate></item>'));
    expect(result.items[0]).toMatchObject({ sourceId: "https://example.com/1", publishedAt: null });
  });
  it("skips unusable items while retaining valid siblings", () => {
    const result = parseAnnouncements(rss(item + '<item><title>Bad</title><link>javascript:alert(1)</link></item><item><link>https://example.com/2</link></item>'));
    expect(result.items).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
  it.each(["<html>Access denied</html>", "<rss><channel>", '<!DOCTYPE rss [<!ENTITY x "test">]><rss><channel/></rss>'])("rejects a non-feed or unsafe XML response", (xml) => {
    expect(() => parseAnnouncements(xml)).toThrow();
  });
  it("fetches and parses RSS with a request timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(rss(item)));
    expect((await fetchAnnouncements(fetcher)).items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("Online_announcements.xml"), expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }));
  });
  it("rejects HTTP errors rather than treating them as an empty feed", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    await expect(fetchAnnouncements(fetcher)).rejects.toThrow("HTTP 403");
  });
  it("rejects oversized responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(5 * 1024 * 1024 + 1)));
    await expect(fetchAnnouncements(fetcher)).rejects.toThrow("exceeds 5 MB");
  });
});
