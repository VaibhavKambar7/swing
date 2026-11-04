import "../src/lib/config/load-env";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { BackupError, fileSha256, postgresConnection, runPostgresTool } from "../src/lib/operations/postgres-tools";
const manifestSchema = z.object({ formatVersion: z.literal(1), filename: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), format: z.literal("postgres-custom") });
async function main() {
  try {
    const [input, confirm, ...extra] = process.argv.slice(2);
    if (!input || confirm !== "--confirm-empty-target" || extra.length) throw new BackupError("RESTORE_CONFIRMATION_REQUIRED");
    const source = postgresConnection(process.env.DATABASE_URL);
    const target = postgresConnection(process.env.RESTORE_DATABASE_URL);
    if (source.identity === target.identity) throw new BackupError("RESTORE_REQUIRES_SEPARATE_TARGET");
    const file = resolve(input);
    const manifestFile = `${file}.json`;
    if ((await stat(manifestFile)).size > 16384) throw new BackupError("INVALID_BACKUP_MANIFEST");
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestFile, "utf8")));
    if (!parsed.success) throw new BackupError("INVALID_BACKUP_MANIFEST");
    const manifest = parsed.data;
    if (manifest.filename !== basename(file) || manifest.bytes !== (await stat(file)).size || manifest.sha256 !== await fileSha256(file)) throw new BackupError("BACKUP_CHECKSUM_MISMATCH");
    await runPostgresTool("pg_restore", ["--list", file], target.env);
    const relations = await runPostgresTool("psql", ["--no-psqlrc", "--no-password", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command=SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')"], target.env);
    if (relations.trim() !== "0") throw new BackupError("RESTORE_TARGET_NOT_EMPTY");
    // No --clean/drop step. Failure rolls the restore transaction back.
    await runPostgresTool("pg_restore", ["--no-password", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", `--dbname=${target.database}`, file], target.env);
    console.log(JSON.stringify({ event: "database_restored_to_separate_target", backup: basename(file) }));
  } catch (error) {
    console.error(JSON.stringify({ event: "database_restore_failed", code: error instanceof BackupError ? error.code : "RESTORE_FAILED" }));
    process.exitCode = 1;
  }
}
void main();
