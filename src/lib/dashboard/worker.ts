import { z } from "zod";
const runtimeSchema = z.object({
  service: z.literal("swing-worker"), status: z.enum(["ok", "degraded"]),
  runtime: z.object({
    checks: z.object({ database: z.enum(["up", "down"]), jobs: z.enum(["up", "down"]), scheduler: z.enum(["up", "down", "disabled"]) }),
    lastJobPollAt: z.string().datetime().nullable(), lastSchedulerTickAt: z.string().datetime().nullable(),
  }),
});
type WorkerResult = { state: "up" | "degraded" | "unavailable"; runtime?: z.infer<typeof runtimeSchema>["runtime"] };
export async function readWorkerStatus(baseUrl: string, fetcher: typeof fetch = fetch): Promise<WorkerResult> {
  try {
    const response = await fetcher(new URL("/health/status", baseUrl), { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(1500) });
    if (![200, 503].includes(response.status)) return { state: "unavailable" as const };
    const parsed = runtimeSchema.safeParse(await response.json());
    if (!parsed.success) return { state: "unavailable" as const };
    return { state: parsed.data.status === "ok" && response.status === 200 ? "up" as const : "degraded" as const, runtime: parsed.data.runtime };
  } catch { return { state: "unavailable" as const }; }
}
