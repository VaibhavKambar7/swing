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

export const JOB_KINDS = ["database.check", "announcements.fetch", "announcements.match", "announcements.filter", "announcements.analyze"] as const;
const emptyPayload = z.object({}).strict();
const analysisPayload = z.object({ limit: z.number().int().min(1).max(20).default(1) }).strict();

export function validateJobPayload(kind: string, payload: unknown) {
  if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new JobError("UNSUPPORTED_JOB_KIND", true);
  const result = (kind === "announcements.analyze" ? analysisPayload : emptyPayload).safeParse(payload);
  if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
  return result.data;
}

export function createJobHandlers(db: PrismaClient): JobHandlers {
  const wrap = (kind: string, action: (payload: { limit?: number }) => Promise<unknown>): JobHandler => async (job, signal) => {
    const payload = validateJobPayload(kind, job.payload);
    signal.throwIfAborted();
    try {
      await action(payload);
    } catch (error) {
      if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
      if (error instanceof AnnouncementFeedError && error.code === "invalid_url") throw new JobError("FEED_CONFIGURATION_REQUIRED", true);
      throw error;
    }
    signal.throwIfAborted();
  };
  return {
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
