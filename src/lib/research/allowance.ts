import type { PrismaClient } from "../../generated/prisma/client";
import { z } from "zod";
import { ResearchError, type ResearchProvider } from "./schema";
export const allowanceLimitsSchema = z.object({
  assessments: z.number().int().min(0).max(10000), attempts: z.number().int().min(0).max(20000),
}).strict();
export type AllowanceLimits = z.infer<typeof allowanceLimitsSchema>;
export class ResearchAllowanceError extends ResearchError {
  constructor(code: "daily_ai_assessment_limit" | "daily_ai_attempt_limit") { super(code); }
}
export function configuredAllowance(): AllowanceLimits {
  return allowanceLimitsSchema.parse({ assessments: Number(process.env.AI_DAILY_ASSESSMENT_LIMIT ?? 10), attempts: Number(process.env.AI_DAILY_ATTEMPT_LIMIT ?? 20) });
}
async function databaseDay(db: Pick<PrismaClient, "$queryRaw">) {
  const [row] = await db.$queryRaw<{ day: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day`;
  return new Date(`${row.day}T00:00:00Z`);
}
export async function getDailyAllowance(db: PrismaClient, limits = configuredAllowance()) {
  limits = allowanceLimitsSchema.parse(limits);
  return db.$transaction(async (tx) => {
    const day = await databaseDay(tx);
    const groups = await tx.researchAllowanceUse.groupBy({ by: ["status"], where: { day }, _count: { _all: true } });
    const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
    const success = count("success"), pending = count("pending"), failed = count("failed");
    return { day: day.toISOString().slice(0, 10), limits, success, pending, failed, attempts: success + pending + failed,
      remaining: Math.max(0, Math.min(limits.assessments - success - pending, limits.attempts - success - pending - failed)),
    };
  }, { isolationLevel: "RepeatableRead" });
}
export async function reserveAiRequest(db: PrismaClient, provider: string, model: string, limits = configuredAllowance()) {
  limits = allowanceLimitsSchema.parse(limits);
  return db.$transaction(async (tx) => {
    // One personal workspace: all callers share the same budget lock. It is
    // independent of process memory, worker count, provider, and retry cycle.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(584924)`;
    const day = await databaseDay(tx);
    const groups = await tx.researchAllowanceUse.groupBy({ by: ["status"], where: { day }, _count: { _all: true } });
    const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
    const success = count("success"), pending = count("pending"), failed = count("failed");
    if (success + pending + failed >= limits.attempts) throw new ResearchAllowanceError("daily_ai_attempt_limit");
    if (success + pending >= limits.assessments) throw new ResearchAllowanceError("daily_ai_assessment_limit");
    return tx.researchAllowanceUse.create({ data: { day, provider, model }, select: { id: true } });
  });
}
export function withDailyAllowance(db: PrismaClient, provider: ResearchProvider, limits?: AllowanceLimits): ResearchProvider {
  return { ...provider, async analyze(input, signal) {
    signal?.throwIfAborted();
    const reservation = await reserveAiRequest(db, provider.name, provider.model, limits);
    let result;
    try { result = await provider.analyze(input, signal); }
    catch (error) {
      const errorCode = signal?.aborted ? "request_cancelled" : error instanceof ResearchError ? error.code : "provider_request_failed";
      await db.researchAllowanceUse.update({ where: { id: reservation.id }, data: { status: "failed", completedAt: new Date(), errorCode } });
      throw error;
    }
    // A validated provider response consumes allowance even if later source
    // changes, cancellation or a storage error prevent creating an assessment.
    await db.researchAllowanceUse.update({ where: { id: reservation.id }, data: { status: "success", completedAt: new Date() } });
    return result;
  } };
}
