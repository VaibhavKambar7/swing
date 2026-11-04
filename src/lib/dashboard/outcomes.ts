import type { PrismaClient } from "../../generated/prisma/client";
export async function getResearchOutcomes(db: PrismaClient, page = 1) {
  const [pending, measured, unavailable, items] = await db.$transaction([
    db.researchFollowUp.count({ where: { status: "pending" } }), db.researchFollowUp.count({ where: { status: "measured" } }), db.researchFollowUp.count({ where: { status: "unavailable" } }),
    db.researchFollowUp.findMany({ orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50, skip: (page - 1) * 50, include: {
      feedResearch: { select: { id: true, createdAt: true, classification: true, feedItem: { select: { id: true, title: true, instrument: { select: { symbol: true } } } } } },
      analysis: { select: { id: true, createdAt: true, signal: { select: { id: true, instrument: { select: { symbol: true } } } } } },
      referenceSnapshot: { select: { provider: true, providerSymbol: true, quoteDelayStatus: true } },
    } }),
  ], { isolationLevel: "RepeatableRead" });
  return { pending, measured, unavailable, items };
}
