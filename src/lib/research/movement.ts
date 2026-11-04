import { supportedFeedWhere } from "../announcements/coverage";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { RELEVANCE_RULE_VERSION } from "../announcements/filter";
import { ResearchError, researchSchemaFor, type MovementResearchInput, type ResearchProvider } from "./schema";

export const MOVEMENT_RESEARCH_VERSION = "movement-context-v1";
const sourceIds = z.object({ currentSnapshotId: z.string().uuid(), referenceSnapshotId: z.string().uuid() });

async function movementInput(db: PrismaClient, signalId: string, at: Date) {
  if (!z.string().uuid().safeParse(signalId).success || !Number.isFinite(at.getTime())) throw new ResearchError("invalid_movement_request");
  const signal = await db.signal.findFirst({ where: { id: signalId, origin: "movement", instrument: { active: true, inUniverse: true, exchange: "NSE", kind: "equity" } }, include: { instrument: true } });
  if (!signal?.price || !signal.referencePrice || !signal.priceChangePct || !signal.windowStart || signal.observedAt > at) throw new ResearchError("movement_unavailable");
  const ids = sourceIds.safeParse(signal.context);
  if (!ids.success) throw new ResearchError("movement_sources_missing");
  const [current, reference] = await Promise.all([
    db.marketSnapshotRecord.findUnique({ where: { id: ids.data.currentSnapshotId } }),
    db.marketSnapshotRecord.findUnique({ where: { id: ids.data.referenceSnapshotId } }),
  ]);
  if (!current?.quotePrice || !reference?.quotePrice || !current.quoteTime || !reference.quoteTime ||
      current.instrumentId !== signal.instrumentId || reference.instrumentId !== signal.instrumentId ||
      current.provider !== reference.provider || current.providerSymbol !== reference.providerSymbol || current.currency !== reference.currency ||
      current.currency !== "INR" || current.retrievedAt > at || reference.retrievedAt > at ||
      !current.quotePrice.eq(signal.price) || !reference.quotePrice.eq(signal.referencePrice) || current.quoteTime.getTime() !== signal.observedAt.getTime() || reference.quoteTime.getTime() !== signal.windowStart.getTime()) throw new ResearchError("movement_sources_mismatch");
  const upper = new Date(Math.min(at.getTime(), signal.observedAt.getTime() + 30 * 60000));
  const filings = await db.feedItem.findMany({ where: {
    AND: [supportedFeedWhere], instrumentId: signal.instrumentId, matchStatus: "matched",
    relevanceStatus: { in: ["keep", "review"] }, relevanceRuleVersion: RELEVANCE_RULE_VERSION,
    publishedAt: { gte: new Date(signal.observedAt.getTime() - 86400000), lte: upper }, discoveredAt: { lte: at },
  }, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], take: 30 });
  const seen = new Set<string>();
  const selected = filings.filter((entry) => { if (seen.has(entry.url)) return false; seen.add(entry.url); return true; }).slice(0, 5);
  const context = signal.context && typeof signal.context === "object" && !Array.isArray(signal.context) ? signal.context.marketContext : null;
  const contextText = context ? JSON.stringify(context, (key, value) => key === "snapshotPairs" ? undefined : value) : null;
  const input: MovementResearchInput = {
    ...(contextText ? { marketContext: contextText.slice(0, 10000) } : {}),
    stock: { exchange: signal.instrument.exchange, symbol: signal.instrument.symbol, name: signal.instrument.name },
    movement: { signalId, observedAt: signal.observedAt.toISOString(), referenceAt: signal.windowStart.toISOString(),
      price: signal.price.toString(), referencePrice: signal.referencePrice.toString(), changePct: signal.priceChangePct.toString(),
      priceAgeAtResearchSeconds: (at.getTime() - signal.observedAt.getTime()) / 1000,
      source: current.provider, providerSymbol: current.providerSymbol, delayStatus: current.quoteDelayStatus ?? "unknown", sourceSnapshotIds: [current.id, reference.id] },
    evidence: [
      { id: "movement", kind: "market_observation", title: "Stored same-session quote movement", url: null, description: null,
        publishedAt: signal.observedAt.toISOString(), discoveredAt: null, timing: "observed_price_event", knownAtMove: null },
      ...selected.map((entry) => ({ id: `announcement:${entry.id}`, kind: entry.source.startsWith("news-search:") ? "news" as const : "official_announcement" as const, title: entry.title.slice(0, 2000), url: entry.url,
        description: entry.description?.slice(0, 4000) ?? null, publishedAt: entry.publishedAt!.toISOString(), discoveredAt: entry.discoveredAt.toISOString(),
        timing: entry.publishedAt! > signal.observedAt ? "published_after_move" : "published_before_or_at_move",
        knownAtMove: entry.publishedAt! <= signal.observedAt && entry.discoveredAt <= signal.observedAt })),
    ], researchedAt: at.toISOString(),
    contentTruncated: (contextText?.length ?? 0) > 10000 || selected.some((entry) => entry.title.length > 2000 || (entry.description?.length ?? 0) > 4000) || filings.length > selected.length,
  };
  return { input, signal, selected };
}

function fingerprint(input: MovementResearchInput) {
  // Wall clock age is metadata, not a reason to pay for the same research again.
  const { researchedAt: _at, movement, ...rest } = input;
  const { priceAgeAtResearchSeconds: _age, ...event } = movement;
  void _at; void _age;
  return createHash("sha256").update(JSON.stringify({ ...rest, movement: event })).digest("hex");
}

export async function researchMovement(db: PrismaClient, signalId: string, provider?: ResearchProvider, at = new Date(), abort?: AbortSignal) {
  abort?.throwIfAborted();
  const { input, selected } = await movementInput(db, signalId, at);
  const linked = selected.length ? await db.signalEvidence.createMany({ data: selected.map((entry) => ({
    signalId, kind: entry.source.startsWith("news-search:") ? "news" : "official_announcement", url: entry.url, title: entry.title, publisher: entry.source,
    excerpt: entry.description?.slice(0, 4000) ?? null, publishedAt: entry.publishedAt, retrievedAt: at,
    contentHash: createHash("sha256").update(JSON.stringify([entry.id, entry.title, entry.description, entry.publishedAt])).digest("hex"),
  })), skipDuplicates: true }) : { count: 0 };
  if (!provider) return { status: "linked", signalId, evidenceCount: selected.length, evidenceInserted: linked.count, catalystVerified: false };
  const hash = fingerprint(input);
  const identity = { signalId, provider: provider.name, model: provider.model, promptVersion: MOVEMENT_RESEARCH_VERSION, inputHash: hash };
  const prior = await db.analysis.findFirst({ where: { ...identity, provider: undefined, model: undefined, OR: (provider.identities ?? [provider]).map((p) => ({ provider: p.name, model: p.model })) }, select: { id: true } });
  if (prior) return { status: "duplicate", signalId, analysisId: prior.id, evidenceCount: selected.length, catalystVerified: false };
  const result = await provider.analyze(input, abort);
  abort?.throwIfAborted();
  const checked = researchSchemaFor(input.evidence.map((entry) => entry.id), "movement").safeParse(result.assessment);
  if (!checked.success) throw new ResearchError("invalid_movement_research");
  const assessment = checked.data;
  identity.provider = result.provider ?? provider.name;
  identity.model = result.model ?? provider.model;
  if (fingerprint((await movementInput(db, signalId, at)).input) !== hash) throw new ResearchError("movement_context_changed");
  const inserted = await db.$transaction(async (tx) => {
    const stillEligible = await tx.signal.findFirst({ where: { id: signalId, origin: "movement", instrument: { active: true, inUniverse: true } } });
    if (!stillEligible) throw new ResearchError("movement_unavailable");
    const written = await tx.analysis.createMany({ data: [{ ...identity, inputSnapshot: input, summary: assessment.summary,
      catalyst: null, catalystVerified: false, risks: assessment.risks, uncertainties: assessment.uncertainties,
      assessment: { ...assessment, significance: assessment.significance, evidence: input.evidence },
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    }], skipDuplicates: true });
    return written.count === 1;
  });
  const stored = await db.analysis.findFirstOrThrow({ where: identity, select: { id: true } });
  return { status: inserted ? "analyzed" : "duplicate", signalId, analysisId: stored.id, evidenceCount: selected.length, catalystVerified: false };
}
