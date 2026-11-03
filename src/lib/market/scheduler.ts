import type { PrismaClient } from "../../generated/prisma/client";
import { CalendarError, getMarketState, type MarketCalendar } from "./calendar";

export function planAnnouncementRun(calendar: MarketCalendar, at: Date) {
  const state = getMarketState(calendar, at);
  if (state.status === "unknown") throw new CalendarError("CALENDAR_COVERAGE_REQUIRED");
  const open = state.status === "open";
  const cadenceMs = open ? 300000 : 3600000;
  const anchor = open ? Date.parse(state.currentSession!.opensAt) : -19800000; // IST hour alignment.
  const slotStart = new Date(anchor + Math.floor((at.getTime() - anchor) / cadenceMs) * cadenceMs).toISOString();
  return {
    mode: open ? "session" : "off_hours", cadenceMs, slotStart,
    dedupeKey: `scheduled:announcements:v1:${open ? "session" : "off-hours"}:${slotStart}`,
  };
}

export async function scheduleAnnouncementRun(
  db: PrismaClient, calendar: MarketCalendar,
  options: { analyze: boolean; analysisLimit: number }, at = new Date(),
) {
  const plan = planAnnouncementRun(calendar, at);
  if (!Number.isInteger(options.analysisLimit) || options.analysisLimit < 1 || options.analysisLimit > 20) throw new Error("Invalid scheduler analysis limit");
  return db.$transaction(async (tx) => {
    const checkpoint = await tx.pollingCheckpoint.upsert({
      where: { source_scope: { source: "swing-scheduler", scope: "announcements-v1" } },
      create: { source: "swing-scheduler", scope: "announcements-v1" }, update: { lastAttemptAt: at },
    });
    // Serialize scheduler replicas using a durable row, not a process-local lock.
    await tx.$queryRaw`SELECT id FROM polling_checkpoints WHERE id = ${checkpoint.id}::uuid FOR UPDATE`;
    const existing = await tx.job.findUnique({ where: { dedupeKey: plan.dedupeKey }, select: { id: true } });
    let status: "already_scheduled" | "busy" | "enqueued";
    let jobId = existing?.id;
    if (existing) status = "already_scheduled";
    else if (await tx.job.findFirst({ where: { kind: "announcements.pipeline", status: { in: ["pending", "retry", "running"] } }, select: { id: true } })) status = "busy";
    else {
      const job = await tx.job.create({ data: {
        kind: "announcements.pipeline", dedupeKey: plan.dedupeKey,
        payload: { analyze: options.analyze, analysisLimit: options.analysisLimit }, runAfter: at,
      } });
      status = "enqueued";
      jobId = job.id;
    }
    await tx.pollingCheckpoint.update({ where: { id: checkpoint.id }, data: {
      lastAttemptAt: at, lastSuccessAt: at, lastErrorCode: null, updatedAt: at,
      ...(status === "enqueued" ? { cursor: { slotStart: plan.slotStart, mode: plan.mode, dedupeKey: plan.dedupeKey } } : {}),
    } });
    return { ...plan, status, jobId };
  });
}
