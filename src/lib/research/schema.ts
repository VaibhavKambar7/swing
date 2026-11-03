import { z } from "zod";

export const RESEARCH_PROMPT_VERSION = "announcement-research-v1";
const sentence = z.string().trim().min(1).max(2000);
export const researchSchema = z.object({
  classification: z.enum(["INVESTIGATE", "WATCH", "IGNORE"]),
  summary: sentence,
  significance: sentence,
  risks: z.array(sentence).min(1).max(6),
  uncertainties: z.array(sentence).min(1).max(6),
  evidenceIds: z.array(z.literal("announcement")).length(1),
}).strict();
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
export type ResearchProvider = {
  name: string;
  model: string;
  analyze(input: ResearchInput): Promise<ResearchResult>;
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
