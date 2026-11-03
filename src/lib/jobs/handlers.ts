import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { fetchAnnouncements, AnnouncementFeedError } from "../announcements/rss";
import { storeAnnouncements } from "../announcements/ingest";
import { matchStoredAnnouncements } from "../announcements/match";
import { filterStoredAnnouncements } from "../announcements/filter";
import { analyzeStoredAnnouncements } from "../research/analyze";
import { createGeminiProvider } from "../research/gemini";
import { ResearchError } from "../research/schema";
import { JobError } from "./queue";
import type { JobHandler, JobHandlers } from "./runner";
import { createPipelineStages, runAnnouncementPipeline, type PipelineStages } from "./pipeline";
import { researchMovement } from "../research/movement";

export const JOB_KINDS = ["database.check", "announcements.fetch", "announcements.match", "announcements.filter", "announcements.analyze", "announcements.pipeline", "movements.research"] as const;
const emptyPayload = z.object({}).strict();
const analysisPayload = z.object({ limit: z.number().int().min(1).max(20).default(1) }).strict();
const pipelinePayload = z.object({ analyze: z.boolean().default(false), analysisLimit: z.number().int().min(1).max(20).default(1) }).strict();
const movementPayload = z.object({ signalId: z.string().uuid(), analyze: z.boolean().default(false) }).strict();

export function validateJobPayload(kind: string, payload: unknown) {
  if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new JobError("UNSUPPORTED_JOB_KIND", true);
  const result = (kind === "movements.research" ? movementPayload : kind === "announcements.pipeline" ? pipelinePayload : kind === "announcements.analyze" ? analysisPayload : emptyPayload).safeParse(payload);
  if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
  return result.data;
}

export function createJobHandlers(db: PrismaClient, stages: PipelineStages = createPipelineStages(db)): JobHandlers {
  const wrap = (kind: string, action: (payload: { limit?: number }) => Promise<unknown>): JobHandler => async (job, signal) => {
    const payload = validateJobPayload(kind, job.payload);
    signal.throwIfAborted();
    try {
      await action("limit" in payload ? { limit: payload.limit } : {});
    } catch (error) {
      if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
      if (error instanceof AnnouncementFeedError && error.code === "invalid_url") throw new JobError("FEED_CONFIGURATION_REQUIRED", true);
      throw error;
    }
    signal.throwIfAborted();
  };
  return {
    "movements.research": async (job, signal) => {
      const result = movementPayload.safeParse(job.payload);
      if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
      signal.throwIfAborted();
      try {
        await researchMovement(db, result.data.signalId, result.data.analyze ? createGeminiProvider() : undefined);
      } catch (error) {
        if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
        if (error instanceof ResearchError && ["movement_unavailable", "movement_sources_missing", "movement_sources_mismatch", "invalid_movement_request"].includes(error.code)) throw new JobError("MOVEMENT_CONTEXT_UNAVAILABLE", true);
        throw error;
      }
      signal.throwIfAborted();
    },
    "announcements.pipeline": async (job, signal) => {
      // Validate before any network or database side effects.
      const result = pipelinePayload.safeParse(job.payload);
      if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
      await runAnnouncementPipeline(stages, result.data, signal);
    },
    "database.check": wrap("database.check", () => db.$queryRaw`SELECT 1`),
    "announcements.fetch": wrap("announcements.fetch", async () => {
      const feed = await fetchAnnouncements();
      await storeAnnouncements(db, feed.items);
    }),
    "announcements.match": wrap("announcements.match", () => matchStoredAnnouncements(db)),
    "announcements.filter": wrap("announcements.filter", () => filterStoredAnnouncements(db)),
    "announcements.analyze": wrap("announcements.analyze", async (payload) => {
      const result = await analyzeStoredAnnouncements(db, createGeminiProvider(), payload.limit);
      if (result.failed) throw new JobError("RESEARCH_ITEMS_FAILED");
    }),
  };
}
