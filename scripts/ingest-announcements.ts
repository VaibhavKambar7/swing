import "../src/lib/config/load-env";
import { fetchAnnouncements } from "../src/lib/announcements/rss";
import { storeAnnouncements } from "../src/lib/announcements/ingest";
import { closeDatabase, getDatabase } from "../src/lib/db";

async function main() {
  let stage = "fetch";
  try {
    const feed = await fetchAnnouncements();
    stage = "store";
    const result = await storeAnnouncements(getDatabase(), feed.items);
    console.log(JSON.stringify({ event: "announcements_ingested", ...result, skipped: feed.skipped }));
  } catch {
    // Network and database errors can contain connection details; keep CLI logs safe.
    console.error(JSON.stringify({ event: "announcements_ingestion_failed", stage }));
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main();
