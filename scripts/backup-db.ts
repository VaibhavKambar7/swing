import "../src/lib/config/load-env";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { BackupError, fileSha256, postgresConnection, runPostgresTool } from "../src/lib/operations/postgres-tools";

async function main() {
  let partial: string | undefined;
  let partialManifest: string | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length) throw new BackupError("INVALID_ARGUMENTS");
    const directory = process.env.SWING_BACKUP_DIR;
    if (!directory || !isAbsolute(directory)) throw new BackupError("ABSOLUTE_BACKUP_DIRECTORY_REQUIRED");
    const connection = postgresConnection(process.env.DATABASE_URL);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `swing-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.dump`);
    partial = `${file}.partial`; partialManifest = `${file}.json.partial`;
    const handle = await open(partial, "wx", 0o600); await handle.close();
    await runPostgresTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--no-password", `--file=${partial}`], connection.env);
    const info = await stat(partial);
    if (!info.size) throw new BackupError("EMPTY_BACKUP");
    // Archive readability is checked when this command is deliberately run.
    await runPostgresTool("pg_restore", ["--list", partial], connection.env);
    const sha256 = await fileSha256(partial);
    const manifest = { formatVersion: 1, filename: basename(file), createdAt: new Date().toISOString(), bytes: info.size, sha256, format: "postgres-custom" };
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(partial, file); partial = undefined;
    await rename(partialManifest, `${file}.json`); partialManifest = undefined;
    console.log(JSON.stringify({ event: "database_backup_created", file, bytes: info.size, sha256 }));
  } catch (error) {
    if (partial) await unlink(partial).catch(() => undefined);
    if (partialManifest) await unlink(partialManifest).catch(() => undefined);
    console.error(JSON.stringify({ event: "database_backup_failed", code: error instanceof BackupError ? error.code : "BACKUP_STORAGE_FAILED" }));
    process.exitCode = 1;
  }
}
void main();
