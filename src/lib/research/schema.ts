import { z } from "zod";

export const RESEARCH_PROMPT_VERSION = "announcement-research-v2";
const sentence = z.string().trim().min(1).max(2000);
export function researchSchemaFor(ids: string[], requiredId?: string) {
  return z.object({
    classification: z.enum(["INVESTIGATE", "WATCH", "IGNORE"]),
    summary: sentence,
    significance: sentence,
    risks: z.array(sentence).min(1).max(6),
    uncertainties: z.array(sentence).min(1).max(6),
    evidenceIds: z.array(z.string()).min(1).max(6).refine((values) => new Set(values).size === values.length && values.every((id) => ids.includes(id)) && (!requiredId || values.includes(requiredId))),
  }).strict();
}
export const researchSchema = researchSchemaFor(["announcement"]);
export type ResearchAssessment = z.infer<typeof researchSchema>;

export type ResearchInput = {
  stock: { exchange: string; symbol: string; name: string };
  announcement: { title: string; description: string | null; url: string; publishedAt: string | null; discoveredAt: string };
  relevance: { status: string; reason: string | null; ruleVersion: string | null };
  contentTruncated: boolean;
};
export type ResearchResult = {
  assessment: ResearchAssessment;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type MovementResearchInput = {
  stock: { exchange: string; symbol: string; name: string };
  movement: { signalId: string; observedAt: string; referenceAt: string; price: string; referencePrice: string; changePct: string; priceAgeAtResearchSeconds: number; source: string; providerSymbol: string; delayStatus: string; sourceSnapshotIds: string[] };
  evidence: { id: string; kind: "market_observation" | "official_announcement"; title: string; url: string | null; description: string | null; publishedAt: string | null; discoveredAt: string | null; timing: string; knownAtMove: boolean | null }[];
  researchedAt: string;
  contentTruncated: boolean;
};
export type ResearchProvider = {
  name: string;
  model: string;
  analyze(input: ResearchInput | MovementResearchInput): Promise<ResearchResult>;
};

export class ResearchError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    super(`Announcement research failed: ${code}`);
    this.name = "ResearchError";
  }
}

export function parseResearchLimit(args: string[]) {
  if (!args.length) return 5;
  if (args.length !== 2 || args[0] !== "--limit" || !/^\d+$/.test(args[1])) throw new ResearchError("invalid_arguments");
  const limit = Number(args[1]);
  if (limit < 1 || limit > 20) throw new ResearchError("invalid_arguments");
  return limit;
}
