import "../src/lib/config/load-env";
import { AnnouncementFeedError, fetchAnnouncements } from "../src/lib/announcements/rss";
import { parseIngestionArgs, readAnnouncementFile } from "../src/lib/announcements/input";
import { storeAnnouncements } from "../src/lib/announcements/ingest";
import { closeDatabase, getDatabase } from "../src/lib/db";

async function main() {
  let stage = "arguments";
  try {
    const options = parseIngestionArgs(process.argv.slice(2));
    stage = options.file ? "file" : "fetch";
    const feed = options.file ? await readAnnouncementFile(options.file) : await fetchAnnouncements();
    if (options.dryRun) {
      console.log(JSON.stringify({
        event: "announcements_checked", input: options.file ? "file" : "live",
        received: feed.items.length, skipped: feed.skipped,
        publicationDatesMissing: feed.items.filter((item) => !item.publishedAt).length,
        // File checks validate a local input, never live access.
        databaseWrites: false,
      }));
      return;
    }
    stage = "store";
    const result = await storeAnnouncements(getDatabase(), feed.items);
    console.log(JSON.stringify({ event: "announcements_ingested", input: options.file ? "file" : "live", ...result, skipped: feed.skipped }));
  } catch (error) {
    // Network and database errors can contain connection details; keep CLI logs safe.
    console.error(JSON.stringify({
      event: "announcements_ingestion_failed", stage,
      code: error instanceof AnnouncementFeedError ? error.code : "database_error",
      httpStatus: error instanceof AnnouncementFeedError ? error.httpStatus : undefined,
    }));
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main();
