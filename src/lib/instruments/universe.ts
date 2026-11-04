import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
const symbol = z.string().regex(/^[A-Z0-9][A-Z0-9&-]{0,29}$/);
const member = z.object({ symbol, name: z.string().trim().min(1).max(200), kind: z.enum(["equity", "index"]).default("equity"), sector: z.string().max(120).nullable().default(null), isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{10}$/).nullable().default(null), yahooSymbol: z.string().regex(/^[A-Za-z0-9^&._-]{1,100}$/).nullable().default(null), bseCode: z.string().regex(/^\d{6}$/).nullable().default(null), benchmark: symbol.nullable().default(null), sectorIndex: symbol.nullable().default(null) }).strict();
export const universeSchema = z.object({ source: z.string().trim().min(1).max(500), effectiveDate: z.string().date(), members: z.array(member).min(1).max(2000) }).strict().superRefine((data, ctx) => {
  const symbols = new Set<string>();
  for (const item of data.members) {
    if (symbols.has(item.symbol)) ctx.addIssue({ code: "custom", message: "Duplicate symbol", path: ["members"] });
    symbols.add(item.symbol);
    for (const target of [item.benchmark, item.sectorIndex]) if (target && (target === item.symbol || !data.members.some((m) => m.symbol === target && m.kind === "index"))) ctx.addIssue({ code: "custom", message: "Comparison mapping must refer to an index included in this import", path: ["members"] });
  }
});
// Parse quoted official constituent CSVs without inventing members or mappings.
export function parseConstituentCsv(csv: string, source: string, effectiveDate: string) {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(cell.trim()); cell = ""; if (c === '\n') { rows.push(row); row = []; } }
    else if (c !== '\r') cell += c;
  }
  if (quoted) throw new Error("INVALID_CSV");
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map((h) => h.replace(/^\uFEFF/, "").toLowerCase());
  if (!headers?.includes("symbol") || !headers.includes("company name")) throw new Error("CSV_HEADERS_REQUIRED");
  const get = (r: string[], name: string) => r[headers.indexOf(name)] || null;
  return universeSchema.parse({ source, effectiveDate, members: rows.filter((r) => r.some(Boolean)).map((r) => ({ symbol: get(r, "symbol"), name: get(r, "company name"), isin: get(r, "isin code"), sector: get(r, "industry") })) });
}
export async function importUniverse(db: PrismaClient, input: unknown) {
  const data = universeSchema.parse(input);
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(584923)`;
    if (await tx.universeImport.findUnique({ where: { contentHash: hash } })) return { duplicate: true, count: data.members.length };
    const latest = await tx.universeImport.findFirst({ orderBy: { effectiveDate: "desc" } });
    if (latest && latest.effectiveDate > new Date(data.effectiveDate)) throw new Error("OLDER_MEMBERSHIP_REJECTED");
    await tx.instrument.updateMany({ where: { exchange: "NSE", inUniverse: true }, data: { inUniverse: false, updatedAt: new Date() } });
    for (const m of data.members) {
      const fields = { symbol: m.symbol, name: m.name, kind: m.kind, sector: m.sector, isin: m.isin, yahooSymbol: m.yahooSymbol, bseCode: m.bseCode };
      await tx.instrument.upsert({ where: { exchange_symbol: { exchange: "NSE", symbol: m.symbol } }, create: { ...fields, exchange: "NSE", inUniverse: true, refreshedAt: new Date() }, update: { ...fields, inUniverse: true, active: true, refreshedAt: new Date(), updatedAt: new Date() } });
    }
    const members = await tx.instrument.findMany({ where: { exchange: "NSE", inUniverse: true }, select: { id: true, symbol: true } });
    for (const m of data.members) await tx.instrument.update({ where: { exchange_symbol: { exchange: "NSE", symbol: m.symbol } }, data: { benchmarkId: members.find((x) => x.symbol === m.benchmark)?.id ?? null, sectorIndexId: members.find((x) => x.symbol === m.sectorIndex)?.id ?? null } });
    await tx.universeImport.create({ data: { source: data.source, effectiveDate: new Date(data.effectiveDate), members: data.members, contentHash: hash } });
    return { duplicate: false, count: data.members.length };
  }, { timeout: 60000 });
}
