import type { PrismaClient } from "../../generated/prisma/client";
import { NSE_SOURCE, type FeedEntry } from "./rss";

export async function storeAnnouncements(db: PrismaClient, items: FeedEntry[], source: string = NSE_SOURCE) {
  // A database unique index also protects against overlapping runs.
  let inserted = 0;
  for (let offset = 0; offset < items.length; offset += 500) {
  const result = await db.feedItem.createMany({
    data: items.slice(offset, offset + 500).map((item) => ({ source, ...item })),
    skipDuplicates: true,
  });
  inserted += result.count;
  }
  return { received: items.length, inserted, duplicates: items.length - inserted };
}
