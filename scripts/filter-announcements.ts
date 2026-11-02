import "../src/lib/config/load-env";
import { filterStoredAnnouncements, RELEVANCE_RULE_VERSION } from "../src/lib/announcements/filter";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    const counts = await filterStoredAnnouncements(getDatabase());
    console.log(JSON.stringify({ event: "announcements_filtered", ruleVersion: RELEVANCE_RULE_VERSION, ...counts }));
  } catch {
    console.error("Announcement filtering failed. Check database readiness and apply migrations first.");
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main();
