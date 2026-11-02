import type { PrismaClient } from "../../generated/prisma/client";

// Small, editable starter coverage; not a current index membership list.
export const STARTER_UNIVERSE = [
  { symbol: "RELIANCE", name: "Reliance Industries Limited" },
  { symbol: "TCS", name: "Tata Consultancy Services Limited" },
  { symbol: "INFY", name: "Infosys Limited" },
  { symbol: "HDFCBANK", name: "HDFC Bank Limited" },
  { symbol: "ICICIBANK", name: "ICICI Bank Limited" },
  { symbol: "ATHERENERG", name: "Ather Energy Limited" },
];

export async function seedStarterUniverse(db: PrismaClient) {
  const result = await db.instrument.createMany({
    data: STARTER_UNIVERSE.map((stock) => ({ ...stock, exchange: "NSE", inUniverse: true })),
    skipDuplicates: true,
  });
  // Preserve all existing names, settings, and user membership choices.
  return { inserted: result.count };
}
