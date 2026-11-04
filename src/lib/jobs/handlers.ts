import { collectSource } from "../announcements/sources";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { AnnouncementFeedError } from "../announcements/rss";
import { matchStoredAnnouncements } from "../announcements/match";
import { filterStoredAnnouncements } from "../announcements/filter";
import { analyzeStoredAnnouncements } from "../research/analyze";
import { createGeminiProvider } from "../research/gemini";
import { ResearchError } from "../research/schema";
import { JobError } from "./queue";
import type { JobHandler, JobHandlers } from "./runner";
import { createPipelineStages, runAnnouncementPipeline, type PipelineStages } from "./pipeline";
import { researchMovement } from "../research/movement";
import { generateMorningBriefing, BriefingError } from "../briefings/morning";
import { loadMarketCalendar } from "../market/load-calendar";
import { CalendarError, type MarketCalendar } from "../market/calendar";
import { generateClosingBriefing } from "../briefings/closing";
import { reassessMorningWatchlist } from "../briefings/post-open";

import { collectPrice } from "../market-data/collect";
import { priceJobSchema } from "../market-data/scheduler";
import { createMarketProvider } from "../market-data/registry";
import { MarketDataError } from "../market-data/provider";

import { followUpPayload, updateResearchFollowUps } from "../research/followups";

export const JOB_KINDS = ["announcements.research-item", "sources.collect", "research.followups", "prices.collect", "database.check", "announcements.fetch", "announcements.match", "announcements.filter", "announcements.analyze", "announcements.pipeline", "movements.research", "briefings.morning", "briefings.closing", "briefings.reassess"] as const;
const itemResearchPayload = z.object({ feedItemId: z.string().uuid() }).strict();
const sourcePayload = z.object({ sourceId: z.string().min(1).max(100) }).strict();
const emptyPayload = z.object({}).strict();
const analysisPayload = z.object({ limit: z.number().int().min(1).max(20).default(1) }).strict();
const pipelinePayload = z.object({ analyze: z.boolean().default(false), analysisLimit: z.number().int().min(1).max(20).default(1) }).strict();
const movementPayload = z.object({ signalId: z.string().uuid(), analyze: z.boolean().default(false) }).strict();
const briefingPayload = z.object({ sessionDate: z.string().date() }).strict();

export function validateJobPayload(kind: string, payload: unknown) {
  if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new JobError("UNSUPPORTED_JOB_KIND", true);
  const result = (kind === "announcements.research-item" ? itemResearchPayload : kind === "sources.collect" ? sourcePayload : kind === "research.followups" ? followUpPayload : kind === "prices.collect" ? priceJobSchema : ["briefings.morning", "briefings.closing", "briefings.reassess"].includes(kind) ? briefingPayload : kind === "movements.research" ? movementPayload : kind === "announcements.pipeline" ? pipelinePayload : kind === "announcements.analyze" ? analysisPayload : emptyPayload).safeParse(payload);
  if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
  return result.data;
}

export function createJobHandlers(db: PrismaClient, stages: PipelineStages = createPipelineStages(db)): JobHandlers {
  const briefing = (generate: (db: PrismaClient, calendar: MarketCalendar, date?: string) => Promise<unknown>): JobHandler => async (job, signal) => {
    const parsed = briefingPayload.safeParse(job.payload);
    if (!parsed.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
    signal.throwIfAborted();
    try { await generate(db, await loadMarketCalendar(), parsed.data.sessionDate); }
    catch (error) {
      if (error instanceof CalendarError) throw new JobError(error.code, error.code === "INVALID_DATE");
      if (error instanceof BriefingError) throw new JobError(error.code, !["BRIEFING_NOT_DUE", "MORNING_BRIEFING_REQUIRED"].includes(error.code));
      throw error;
    }
    signal.throwIfAborted();
  };
  const wrap = (kind: string, action: (payload: { limit?: number }, signal: AbortSignal) => Promise<unknown>): JobHandler => async (job, signal) => {
    const payload = validateJobPayload(kind, job.payload);
    signal.throwIfAborted();
    try {
      await action("limit" in payload ? { limit: payload.limit } : {}, signal);
    } catch (error) {
      if (error instanceof ResearchError && ["missing_gemini_api_key", "invalid_gemini_model"].includes(error.code)) throw new JobError("AI_CONFIGURATION_REQUIRED", true);
      if (error instanceof AnnouncementFeedError && error.code === "invalid_url") throw new JobError("FEED_CONFIGURATION_REQUIRED", true);
      throw error;
    }
    signal.throwIfAborted();
  };
  return {
    "announcements.research-item": async (job, signal) => {
      const { feedItemId } = itemResearchPayload.parse(job.payload);
      const result = await analyzeStoredAnnouncements(db, createGeminiProvider(), 1, signal, feedItemId);
      if (result.failed) throw new JobError("RESEARCH_ITEMS_FAILED");
      if (!result.analyzed && !result.skipped) throw new JobError("RESEARCH_ITEM_NOT_ELIGIBLE", true);
    },
    "sources.collect": async (job, signal) => {
      const payload = sourcePayload.parse(job.payload);
      await collectSource(db, payload.sourceId, signal);
      signal.throwIfAborted();
      await matchStoredAnnouncements(db);
      await filterStoredAnnouncements(db);
    },
    "research.followups": async (job, signal) => {
      const payload = followUpPayload.safeParse(job.payload);
      if (!payload.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
      signal.throwIfAborted();
      try { await updateResearchFollowUps(db, await loadMarketCalendar(), payload.data.limit, new Date(), signal); }
      catch (error) { if (error instanceof CalendarError) throw new JobError(error.code, true); throw error; }
    },
    "prices.collect": async (job, signal) => {
      const payload = priceJobSchema.safeParse(job.payload);
      if (!payload.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
      signal.throwIfAborted();
      try { await collectPrice(db, createMarketProvider(undefined, db), await loadMarketCalendar(), payload.data, signal); }
      catch (error) {
        if (error instanceof CalendarError) throw new JobError(error.code, true);
        if (error instanceof MarketDataError) {
          const permanent = ["INSTRUMENT_NOT_IN_UNIVERSE", "UNSUPPORTED_INSTRUMENT", "INVALID_HISTORY_DAYS"].includes(error.code) || [400, 404].includes(error.httpStatus ?? 0);
          throw new JobError(error.code, permanent);
        }
        throw error;
      }
    },
    "briefings.morning": briefing(generateMorningBriefing),
    "briefings.closing": briefing(generateClosingBriefing),
    "briefings.reassess": briefing(reassessMorningWatchlist),
    "movements.research": async (job, signal) => {
      const result = movementPayload.safeParse(job.payload);
      if (!result.success) throw new JobError("INVALID_JOB_PAYLOAD", true);
      signal.throwIfAborted();
      try {
        await researchMovement(db, result.data.signalId, result.data.analyze ? createGeminiProvider() : undefined, new Date(), signal);
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
    "announcements.fetch": wrap("announcements.fetch", async (_payload, signal) => {
      await collectSource(db, "nse", signal);
    }),
    "announcements.match": wrap("announcements.match", () => matchStoredAnnouncements(db)),
    "announcements.filter": wrap("announcements.filter", () => filterStoredAnnouncements(db)),
    "announcements.analyze": wrap("announcements.analyze", async (payload, signal) => {
      const result = await analyzeStoredAnnouncements(db, createGeminiProvider(), payload.limit, signal);
      if (result.failed) throw new JobError("RESEARCH_ITEMS_FAILED");
    }),
  };
}
