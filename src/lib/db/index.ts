import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { getEnv } from "../config/env";

function createDatabase() {
  const adapter = new PrismaPg({
    connectionString: getEnv().DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    query_timeout: 3000,
    statement_timeout: 3000,
  }, {
    onPoolError: () => console.error(JSON.stringify({
      service: "database", event: "idle_connection_error", at: new Date().toISOString(),
    })),
  });
  // Disable query/error event logs here so URLs and query parameters stay private.
  return new PrismaClient({ adapter, log: [] });
}

type Database = ReturnType<typeof createDatabase>;
const globalDb = globalThis as typeof globalThis & { swingDatabase?: Database };
export function getDatabase(): Database {
  return (globalDb.swingDatabase ??= createDatabase());
}

export async function closeDatabase(): Promise<void> {
  const database = globalDb.swingDatabase;
  globalDb.swingDatabase = undefined;
  await database?.$disconnect();
}
