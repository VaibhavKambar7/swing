import type { PrismaClient } from "../../generated/prisma/client";
import { fetchAnnouncements, AnnouncementFeedError } from "../announcements/rss";
import { storeAnnouncements } from "../announcements/ingest";
import { matchStoredAnnouncements } from "../announcements/match";
import { filterStoredAnnouncements } from "../announcements/filter";
import { analyzeStoredAnnouncements } from "../research/analyze";
import { createGeminiProvider } from "../research/gemini";
import { ResearchError } from "../research/schema";
import { JobError } from "./queue";

export function createPipelineStages(db: PrismaClient) {
  return {
    fetch: async () => storeAnnouncements(db, (await fetchAnnouncements()).items),
    match: () => matchStoredAnnouncements(db),
    filter: () => filterStoredAnnouncements(db),
    analyze: (limit: number) => analyzeStoredAnnouncements(db, createGeminiProvider(), limit),
  };
}
export type PipelineStages = ReturnType<typeof createPipelineStages>;

export async function runAnnouncementPipeline(
  stages: PipelineStages, options: { analyze: boolean; analysisLimit: number }, signal: AbortSignal,
) {
  let stage = "fetch";
  try {
    signal.throwIfAborted();
    await stages.fetch();
    stage = "match"; signal.throwIfAborted();
    await stages.match();
    stage = "filter"; signal.throwIfAborted();
    await stages.filter();
    if (options.analyze) {
      stage = "analyze"; signal.throwIfAborted();
      const result = await stages.analyze(options.analysisLimit);
      if (result.failed) throw new JobError("PIPELINE_ANALYZE_FAILED");
    }
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof JobError) throw error;
    if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
    if (error instanceof AnnouncementFeedError && error.code === "invalid_url") throw new JobError("FEED_CONFIGURATION_REQUIRED", true);
    throw new JobError(`PIPELINE_${stage.toUpperCase()}_FAILED`);
  }
}
