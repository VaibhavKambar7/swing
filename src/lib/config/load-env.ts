import { loadEnvConfig } from "@next/env";

// Use the same .env loading order as Next.js in CLI scripts and the worker.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
