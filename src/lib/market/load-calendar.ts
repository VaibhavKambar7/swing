import { open } from "node:fs/promises";
import { CalendarError, parseCalendar } from "./calendar";

export async function loadMarketCalendar(path = process.env.MARKET_CALENDAR_FILE) {
  if (!path) throw new CalendarError("MARKET_CALENDAR_FILE_REQUIRED");
  try {
    const file = await open(path, "r");
    try {
      // Bound memory even if a local file is replaced or grows during the read.
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > 256 * 1024) throw new CalendarError("CALENDAR_TOO_LARGE");
      return parseCalendar(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError("CALENDAR_UNREADABLE_OR_INVALID_JSON");
  }
}

export function parseCalendarArgs(args: string[]) {
  let file: string | undefined;
  let at: Date | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new CalendarError("INVALID_ARGUMENTS");
    if (args[i] === "--file" && !file) file = value;
    else if (args[i] === "--at" && !at) {
      // Reject local timestamps: their interpretation otherwise depends on host TZ.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new CalendarError("TIMESTAMP_OFFSET_REQUIRED");
      at = new Date(value);
      if (!Number.isFinite(at.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10)) ||
          new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new CalendarError("INVALID_INSTANT");
    } else throw new CalendarError("INVALID_ARGUMENTS");
  }
  return { file, at };
}
