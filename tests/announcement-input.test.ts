import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseIngestionArgs, readAnnouncementFile } from "../src/lib/announcements/input";
import { MAX_FEED_BYTES } from "../src/lib/announcements/rss";

const run = promisify(execFile);
const fixture = "tests/fixtures/announcements.xml";

describe("announcement command input", () => {
  it("accepts live, dry-run and local-file modes", () => {
    expect(parseIngestionArgs([])).toEqual({ dryRun: false, file: undefined });
    expect(parseIngestionArgs(["--file", fixture, "--dry-run"])).toEqual({ dryRun: true, file: fixture });
  });
  it.each([["--file"], ["--file", "--dry-run"], ["--dryrun"], ["--dry-run", "--dry-run"], ["--file", "a", "--file", "b"]])("rejects malformed arguments", (...args) => {
    expect(() => parseIngestionArgs(args)).toThrow("Usage:");
  });
  it("loads a saved RSS file and retains missing publication dates", async () => {
    const result = await readAnnouncementFile(fixture);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].publishedAt).toBeNull();
  });
  it("rejects oversized local files and missing files with safe diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swing-rss-"));
    try {
      const path = join(directory, "large.xml");
      await writeFile(path, "x".repeat(MAX_FEED_BYTES + 1));
      await expect(readAnnouncementFile(path)).rejects.toMatchObject({ code: "response_too_large" });
      await expect(readAnnouncementFile(join(directory, "missing-secret.xml"))).rejects.toMatchObject({ code: "file_error", message: "Cannot read announcement RSS file" });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it("runs the real CLI in check mode without a usable database or network", async () => {
    const result = await run(process.execPath, ["--import", "tsx", "scripts/ingest-announcements.ts", "--dry-run", "--file", fixture], {
      env: { ...process.env, DATABASE_URL: "invalid-on-purpose", NSE_ANNOUNCEMENTS_URL: "invalid-on-purpose" }, timeout: 15000,
    });
    expect(JSON.parse(result.stdout.trim())).toEqual({ event: "announcements_checked", input: "file", received: 2, skipped: 0, publicationDatesMissing: 1, databaseWrites: false });
  });
  it("returns a failing exit code for invalid CLI arguments", async () => {
    await expect(run(process.execPath, ["--import", "tsx", "scripts/ingest-announcements.ts", "--file"], { timeout: 15000 })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('"code":"invalid_arguments"'),
    });
  });
});
