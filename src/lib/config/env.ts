import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().refine((value) => {
    const parsed = URL.parse(value);
    return parsed !== null && ["postgres:", "postgresql:"].includes(parsed.protocol);
  }),
  WORKER_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_PORT: port.default(3001),
  WORKER_HEALTH_URL: z.string().url().refine((value) => {
    const parsed = URL.parse(value);
    return parsed !== null && ["http:", "https:"].includes(parsed.protocol);
  }).default("http://127.0.0.1:3001"),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  WORKER_JOB_POLL_MS: z.coerce.number().int().min(500).max(60000).default(2000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(input: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    // Report field names only: URLs and provider credentials must never enter logs.
    throw new Error(`Invalid environment variables: ${fields.join(", ")}. See .env.example.`);
  }
  return result.data;
}

let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
