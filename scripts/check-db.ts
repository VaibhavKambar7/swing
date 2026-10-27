import "../src/lib/config/load-env";
import { getEnv } from "../src/lib/config/env";
import { checkDatabase } from "../src/lib/health";
import { closeDatabase } from "../src/lib/db";

async function main() {
  getEnv();
  try {
    const healthy = await checkDatabase();
    console.log(healthy ? "PostgreSQL connection OK (via Prisma)." : "PostgreSQL unavailable. Check DATABASE_URL and start your database.");
    if (!healthy) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
void main().catch(() => {
  console.error("Database check failed. Check environment configuration.");
  process.exitCode = 1;
});
