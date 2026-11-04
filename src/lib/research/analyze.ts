import { ResearchAllowanceError } from "./allowance";
import { supportedFeedWhere } from "../announcements/coverage";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { RELEVANCE_RULE_VERSION } from "../announcements/filter";
import { RESEARCH_PROMPT_VERSION, ResearchError, researchSchema, type ResearchInput, type ResearchProvider } from "./schema";

const eligible = {
  AND: [supportedFeedWhere],
  matchStatus: "matched" as const,
  relevanceStatus: { in: ["keep" as const, "review" as const] },
  relevanceRuleVersion: RELEVANCE_RULE_VERSION,
  instrument: { exchange: "NSE", kind: "equity" as const, active: true, inUniverse: true },
};

type SourceItem = {
  source?: string; title: string; description: string | null; url: string;
  publishedAt: Date | null; discoveredAt: Date;
  relevanceStatus: string; relevanceReason: string | null; relevanceRuleVersion: string | null;
  instrument: { exchange: string; symbol: string; name: string } | null;
};

export function buildResearchInput(item: SourceItem): ResearchInput {
  if (!item.instrument) throw new ResearchError("missing_matched_instrument");
  return {
    stock: { exchange: item.instrument.exchange, symbol: item.instrument.symbol, name: item.instrument.name },
    announcement: {
      source: item.source, evidenceKind: item.source?.startsWith("news-search:") ? "news" : "official_announcement",
      title: item.title.slice(0, 2000), description: item.description?.slice(0, 20000) ?? null,
      url: item.url, publishedAt: item.publishedAt?.toISOString() ?? null, discoveredAt: item.discoveredAt.toISOString(),
    },
    relevance: { status: item.relevanceStatus, reason: item.relevanceReason, ruleVersion: item.relevanceRuleVersion },
    contentTruncated: item.title.length > 2000 || (item.description?.length ?? 0) > 20000,
  };
}

function inputHash(input: ResearchInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function analyzeStoredAnnouncements(db: PrismaClient, provider: ResearchProvider, limit = 5, signal?: AbortSignal, feedItemId?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ResearchError("invalid_limit");
  const counts = { analyzed: 0, skipped: 0, failed: 0, attempted: 0 };
  const failures: { feedItemId: string; code: string; httpStatus?: number }[] = [];
  let cursor: { id: string; publishedAt: Date | null } | undefined;
  while (counts.attempted < limit) {
    signal?.throwIfAborted();
    const items = await db.feedItem.findMany({
      where: { ...eligible, ...(feedItemId ? { id: feedItemId } : {}), ...(cursor ? { AND: [...eligible.AND, cursor.publishedAt ? { OR: [{ publishedAt: { lt: cursor.publishedAt } }, { publishedAt: cursor.publishedAt, id: { lt: cursor.id } }, { publishedAt: null }] } : { publishedAt: null, id: { lt: cursor.id } }] } : {}) },
      include: { instrument: true }, orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }], take: 50,
    });
    if (!items.length) break;
    for (const item of items) {
      if (counts.attempted >= limit) break;
      cursor = { id: item.id, publishedAt: item.publishedAt };
      const input = buildResearchInput(item);
      const hash = inputHash(input);
      const identity = { feedItemId: item.id, provider: provider.name, model: provider.model, promptVersion: RESEARCH_PROMPT_VERSION, inputHash: hash };
      if (await db.feedResearch.findFirst({ where: { ...identity, provider: undefined, model: undefined, OR: (provider.identities ?? [provider]).map((p) => ({ provider: p.name, model: p.model })) }, select: { id: true } })) {
        counts.skipped++;
        continue;
      }
      counts.attempted++;
      try {
        const result = await provider.analyze(input, signal);
        signal?.throwIfAborted();
        const parsed = researchSchema.safeParse(result.assessment);
        if (!parsed.success) throw new ResearchError("invalid_research_output");
        const assessment = parsed.data;
        const inserted = await db.$transaction(async (tx) => {
          const current = await tx.feedItem.findFirst({ where: { ...eligible, id: item.id }, include: { instrument: true } });
          if (!current || inputHash(buildResearchInput(current)) !== hash) return false;
          const written = await tx.feedResearch.createMany({
            data: [{
              ...identity, provider: result.provider ?? provider.name, model: result.model ?? provider.model, inputSnapshot: input, classification: assessment.classification,
              summary: assessment.summary, significance: assessment.significance,
              risks: assessment.risks, uncertainties: assessment.uncertainties,
              // URLs are supplied by Swing, never accepted from generated text.
              evidence: [{ id: "announcement", source: item.source, sourceId: item.sourceId, url: item.url, title: item.title }],
              inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            }], skipDuplicates: true,
          });
          return written.count === 1;
        });
        if (inserted) counts.analyzed++;
        else counts.skipped++;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ResearchAllowanceError) return { ...counts, attempted: counts.attempted - 1, failures, deferred: true, allowanceReason: error.code };
        counts.failed++;
        failures.push({ feedItemId: item.id, code: error instanceof ResearchError ? error.code : "research_storage_failed", httpStatus: error instanceof ResearchError ? error.httpStatus : undefined });
      }
    }
  }
  return { ...counts, failures };
}
