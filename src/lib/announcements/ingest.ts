import type { PrismaClient } from "../../generated/prisma/client";
import { NSE_SOURCE, type FeedEntry } from "./rss";

export async function storeAnnouncements(db: PrismaClient, items: FeedEntry[]) {
  // A database unique index also protects against overlapping runs.
  const result = await db.feedItem.createMany({
    data: items.map((item) => ({ source: NSE_SOURCE, ...item })),
    skipDuplicates: true,
  });
  return { received: items.length, inserted: result.count, duplicates: items.length - result.count };
}
