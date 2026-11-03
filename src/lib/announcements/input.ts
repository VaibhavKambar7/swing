import { createReadStream } from "node:fs";
import { AnnouncementFeedError, MAX_FEED_BYTES, parseAnnouncements } from "./rss";

export function parseIngestionArgs(args: string[]) {
  let dryRun = false;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dryRun) {
      dryRun = true;
    } else if (args[i] === "--file" && !file && args[i + 1] && !args[i + 1].startsWith("--")) {
      file = args[++i];
    } else {
      throw new AnnouncementFeedError("invalid_arguments", "Usage: announcements:fetch [--dry-run] [--file path.xml]");
    }
  }
  return { dryRun, file };
}

export async function readAnnouncementFile(path: string) {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > MAX_FEED_BYTES) throw new AnnouncementFeedError("response_too_large", "Announcement feed exceeds 5 MB");
      chunks.push(chunk);
    }
    return parseAnnouncements(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof AnnouncementFeedError) throw error;
    throw new AnnouncementFeedError("file_error", "Cannot read announcement RSS file");
  }
}
