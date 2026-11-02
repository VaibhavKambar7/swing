import "../src/lib/config/load-env";
import { seedStarterUniverse } from "../src/lib/instruments/starter-universe";
import { getDatabase, closeDatabase } from "../src/lib/db";

async function main() {
  try {
    console.log(JSON.stringify({ event: "starter_universe_seeded", ...await seedStarterUniverse(getDatabase()) }));
  } catch {
    console.error("Universe seed failed. Check database readiness and migrations.");
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main();
