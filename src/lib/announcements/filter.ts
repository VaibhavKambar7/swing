import type { PrismaClient } from "../../generated/prisma/client";
import { NSE_SOURCE } from "./rss";

export const RELEVANCE_RULE_VERSION = "announcement-noise-v1";
export type RelevanceDecision = {
  status: "keep" | "routine" | "review";
  reason: string;
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// A protection list, not an assessment of financial importance. Unfamiliar items
// are retained for review; only narrowly recognized routine subjects are filtered.
const materialContext = /\b(?:results?|earnings|dividends?|acquisitions?|mergers?|demergers?|orders?|contracts?|defaults?|fraud|insolvency|bankruptcy|litigation|penalt(?:y|ies)|resignation|appointments?|management|auditor|ratings?|downgrade|upgrade|fund\s+raising|fundraising|buyback|bonus|split|rights\s+issue|preferential|allotment|pledge|promoter|capital|record\s+date|board\s+meeting|investor\s+presentation|analyst\s+meet|cyber|fire|accident|shutdown|disruption|strike|recall|cancellation|material\s+event)\b/;

const routineSubjects: { reason: string; pattern: RegExp }[] = [
  {
    reason: "ROUTINE_TRADING_WINDOW",
    pattern: /^(?:(?:closure of (?:the )?)?trading window(?: closure)?)$/,
  },
  {
    reason: "ROUTINE_SHARE_CERTIFICATE_NOTICE",
    pattern: /^(?:loss of (?:share )?certificates?|(?:issue|issuance) of duplicate (?:share )?certificates?|duplicate share certificates?|loss of share certificates? (?:and )?(?:issue|issuance) of duplicate share certificates?)$/,
  },
  {
    reason: "ROUTINE_DEPOSITORY_CERTIFICATE",
    pattern: /^(?:compliance )?certificate (?:under|pursuant to) regulation 74 5(?: of (?:the )?sebi depositories and participants regulations 2018)?$/,
  },
];

export function classifyAnnouncementRelevance(input: { title: string; description: string | null }): RelevanceDecision {
  const description = input.description ?? "";
  if (input.title.length > 2000 || description.length > 20000) return { status: "review", reason: "CONTENT_TOO_LARGE_FOR_RULES" };
  // Split a matched issuer heading from its subject. A heading without a subject
  // cannot prove a filing is routine. Hyphenated issuer names remain conservative.
  const heading = input.title.replace(/^\s*NSE\s*:\s*/i, "");
  const separator = /\s+[-–—]\s+|[|:]/.exec(heading);
  const subject = separator ? heading.slice(separator.index + separator[0].length).trim() : "";
  if (!subject) return { status: "review", reason: "SUBJECT_NOT_IDENTIFIED" };
  const normalizedSubject = normalize(subject);
  const context = `${normalizedSubject} ${normalize(description)}`;
  if (materialContext.test(context)) return { status: "keep", reason: "POTENTIALLY_MATERIAL_CONTEXT" };
  // Encoded text can conceal words from a simple keyword guard. Don't guess or
  // strip it away and accidentally hide a meaningful disclosure.
  if (/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(subject + description)) return { status: "review", reason: "ENCODED_CONTENT_NEEDS_REVIEW" };
  for (const rule of routineSubjects) {
    if (rule.pattern.test(normalizedSubject)) {
      const body = normalize(description);
      if (body && body !== normalizedSubject && !routineSubjects.some((entry) => entry.pattern.test(body))) return { status: "review", reason: "UNRECOGNIZED_ROUTINE_BODY" };
      return { status: "routine", reason: rule.reason };
    }
  }
  return { status: "review", reason: "UNRECOGNIZED_SUBJECT" };
}

export async function filterStoredAnnouncements(db: PrismaClient, now: () => Date = () => new Date()) {
  const counts = { keep: 0, routine: 0, review: 0 };
  const eligible = {
    source: NSE_SOURCE,
    matchStatus: "matched" as const,
    instrument: { exchange: "NSE", kind: "equity" as const, active: true, inUniverse: true },
    OR: [
      { relevanceStatus: "pending" as const },
      { relevanceRuleVersion: { not: RELEVANCE_RULE_VERSION } },
    ],
  };
  let cursor: string | undefined;
  while (true) {
    const items = await db.feedItem.findMany({
      where: { ...eligible, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: 100,
      select: { id: true, title: true, description: true },
    });
    if (!items.length) break;
    for (const item of items) {
      const decision = classifyAnnouncementRelevance(item);
      const result = await db.feedItem.updateMany({
        // Repeat eligibility in the write: overlapping commands must not overwrite
        // a decision already produced by the current rules or an invalidated match.
        where: { ...eligible, id: item.id },
        data: {
          relevanceStatus: decision.status, relevanceReason: decision.reason,
          relevanceRuleVersion: RELEVANCE_RULE_VERSION, relevanceCheckedAt: now(),
        },
      });
      counts[decision.status] += result.count;
    }
    cursor = items[items.length - 1].id;
  }
  return counts;
}
