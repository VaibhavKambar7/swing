import "../src/lib/config/load-env";
import { matchStoredAnnouncements } from "../src/lib/announcements/match";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    console.log(JSON.stringify({ event: "announcements_matched", ...await matchStoredAnnouncements(getDatabase()) }));
  } catch {
    console.error("Announcement matching failed. Check database readiness and ensure active NSE stocks are configured.");
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main();
