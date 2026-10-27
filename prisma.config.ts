import "./src/lib/config/load-env";
import { defineConfig } from "prisma/config";
import { getEnv } from "./src/lib/config/env";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Client generation works before .env exists (for npm ci and Docker builds).
  datasource: process.env.DATABASE_URL ? { url: getEnv().DATABASE_URL } : undefined,
});
