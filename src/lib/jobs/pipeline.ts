import type { PrismaClient } from "../../generated/prisma/client";
import { AnnouncementFeedError } from "../announcements/rss";
import { collectEnabledSources } from "../announcements/sources";
import { matchStoredAnnouncements } from "../announcements/match";
import { filterStoredAnnouncements } from "../announcements/filter";
import { analyzeStoredAnnouncements } from "../research/analyze";
import { createResearchProvider } from "../research/provider";
import { ResearchError } from "../research/schema";
import { JobError } from "./queue";

export function createPipelineStages(db: PrismaClient): PipelineStages {
  return {
    fetch: async (signal?: AbortSignal) => collectEnabledSources(db, signal),
    match: () => matchStoredAnnouncements(db),
    filter: () => filterStoredAnnouncements(db),
    analyze: (limit: number, signal?: AbortSignal) => analyzeStoredAnnouncements(db, createResearchProvider(), limit, signal),
  };
}
export type PipelineStages = {
 fetch: (signal?: AbortSignal) => Promise<{ received: number; inserted: number; duplicates: number; failed?: number }>;
 match: () => Promise<unknown>;
 filter: () => Promise<unknown>;
 analyze: (limit: number, signal?: AbortSignal) => Promise<{ failed: number }>;
};

export async function runAnnouncementPipeline(
  stages: PipelineStages, options: { analyze: boolean; analysisLimit: number }, signal: AbortSignal,
) {
  let stage = "fetch";
  try {
    signal.throwIfAborted();
    const fetched = await stages.fetch(signal);
    stage = "match"; signal.throwIfAborted();
    await stages.match();
    stage = "filter"; signal.throwIfAborted();
    await stages.filter();
    if (options.analyze) {
      stage = "analyze"; signal.throwIfAborted();
      const result = await stages.analyze(options.analysisLimit, signal);
      if (result.failed) throw new JobError("PIPELINE_ANALYZE_FAILED");
    }
    if ("failed" in fetched && fetched.failed) throw new JobError("PIPELINE_SOURCE_COLLECTION_FAILED");
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof JobError) throw error;
    if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model", "missing_groq_api_key", "invalid_groq_model", "invalid_research_provider", "invalid_fallback_provider"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
    if (error instanceof AnnouncementFeedError && error.code === "invalid_url") throw new JobError("FEED_CONFIGURATION_REQUIRED", true);
    throw new JobError(`PIPELINE_${stage.toUpperCase()}_FAILED`);
  }
}
