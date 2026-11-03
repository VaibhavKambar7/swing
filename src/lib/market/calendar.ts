import { z } from "zod";

export const MARKET_TIMEZONE = "Asia/Kolkata";
const DAY_MS = 86400000;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return value >= "1970-01-01" && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const sessionSchema = z.object({ open: timeSchema, close: timeSchema }).strict()
  .refine((value) => value.open < value.close, "Session must open before it closes on the same IST date");

export const calendarSchema = z.object({
  source: z.string().trim().min(1).max(500),
  coverageStart: dateSchema,
  coverageEnd: dateSchema,
  holidays: z.array(z.object({ date: dateSchema, name: z.string().trim().min(1).max(200) }).strict()).max(1000),
  specialSessions: z.array(z.object({
    date: dateSchema, name: z.string().trim().min(1).max(200),
    // An empty array explicitly closes a normally open day.
    sessions: z.array(sessionSchema).max(10),
  }).strict()).max(1000),
}).strict().superRefine((calendar, context) => {
  if (calendar.coverageStart > calendar.coverageEnd ||
    new Date(calendar.coverageEnd).getTime() - new Date(calendar.coverageStart).getTime() > 3660 * DAY_MS) {
    context.addIssue({ code: "custom", message: "Coverage must be ordered and at most ten years", path: ["coverageEnd"] });
  }
  for (const key of ["holidays", "specialSessions"] as const) {
    const seen = new Set<string>();
    for (const entry of calendar[key]) {
      if (seen.has(entry.date) || entry.date < calendar.coverageStart || entry.date > calendar.coverageEnd) {
        context.addIssue({ code: "custom", message: "Duplicate or out-of-coverage date", path: [key] });
      }
      seen.add(entry.date);
    }
  }
  for (const entry of calendar.specialSessions) {
    for (let i = 1; i < entry.sessions.length; i++) {
      if (entry.sessions[i].open < entry.sessions[i - 1].close) {
        context.addIssue({ code: "custom", message: "Sessions must be ordered and non-overlapping", path: ["specialSessions"] });
      }
    }
  }
});
export type MarketCalendar = z.infer<typeof calendarSchema>;
type Session = { open: string; close: string };
export type MarketDay = { date: string; kind: "regular" | "holiday" | "weekend" | "special" | "unknown"; name: string | null; sessions: Session[] };

export class CalendarError extends Error {
  constructor(public readonly code: string) {
    super(`Market calendar: ${code}`);
  }
}

export function parseCalendar(value: unknown): MarketCalendar {
  const result = calendarSchema.safeParse(value);
  if (!result.success) throw new CalendarError("INVALID_CALENDAR");
  return result.data;
}

export function getMarketDay(calendar: MarketCalendar, date: string): MarketDay {
  if (!dateSchema.safeParse(date).success) throw new CalendarError("INVALID_DATE");
  if (date < calendar.coverageStart || date > calendar.coverageEnd) return { date, kind: "unknown", name: null, sessions: [] };
  // Explicit exchange overrides take priority over both holidays and weekends.
  const special = calendar.specialSessions.find((entry) => entry.date === date);
  if (special) return { date, kind: "special", name: special.name, sessions: special.sessions };
  const holiday = calendar.holidays.find((entry) => entry.date === date);
  if (holiday) return { date, kind: "holiday", name: holiday.name, sessions: [] };
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return { date, kind: "weekend", name: null, sessions: [] };
  return { date, kind: "regular", name: null, sessions: [{ open: "09:15", close: "15:30" }] };
}

const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

export function marketDate(at: Date) {
  if (!Number.isFinite(at.getTime())) throw new CalendarError("INVALID_INSTANT");
  const parts = localDateFormatter.formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function sessionInstants(date: string, session: Session) {
  // Current Indian equity sessions use fixed IST, UTC+05:30 (no DST).
  return { date, open: session.open, close: session.close,
    opensAt: new Date(`${date}T${session.open}:00+05:30`).toISOString(),
    closesAt: new Date(`${date}T${session.close}:00+05:30`).toISOString() };
}

export function getMarketState(calendar: MarketCalendar, at: Date = new Date()) {
  const date = marketDate(at);
  const day = getMarketDay(calendar, date);
  const sessions = day.sessions.map((session) => sessionInstants(date, session));
  const now = at.getTime();
  const currentSession = sessions.find((session) => Date.parse(session.opensAt) <= now && now < Date.parse(session.closesAt)) ?? null;
  let nextSession = sessions.find((session) => Date.parse(session.opensAt) > now) ?? null;
  if (!nextSession && day.kind !== "unknown") {
    const end = Date.parse(`${calendar.coverageEnd}T00:00:00Z`);
    for (let searchTime = Date.parse(`${date}T00:00:00Z`) + DAY_MS; searchTime <= end; searchTime += DAY_MS) {
      const search = new Date(searchTime).toISOString().slice(0, 10);
      const next = getMarketDay(calendar, search);
      if (next.sessions.length) { nextSession = sessionInstants(search, next.sessions[0]); break; }
    }
  }
  const status = day.kind === "unknown" ? "unknown" : currentSession ? "open" : !sessions.length ? "closed"
    : now < Date.parse(sessions[0].opensAt) ? "before_open"
    : now >= Date.parse(sessions[sessions.length - 1].closesAt) ? "after_close" : "between_sessions";
  return {
    asOf: at.toISOString(), timezone: MARKET_TIMEZONE, localDate: date,
    calendarSource: calendar.source, coverageStart: calendar.coverageStart, coverageEnd: calendar.coverageEnd,
    dayKind: day.kind, dayName: day.name, status,
    isTradingDay: day.kind === "unknown" ? null : sessions.length > 0,
    currentSession, nextSession,
    nextSessionUnavailableReason: nextSession ? null : "CALENDAR_COVERAGE_EXHAUSTED",
  };
}
