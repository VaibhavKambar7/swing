# Database backup and recovery

This is operational code and a recovery procedure. No backup or restore has been
run as part of implementation. Validate a full restore before relying on it.
No Docker is required.

Install PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) matching the
server major version or a supported newer client. Use the direct PostgreSQL
endpoint rather than a transaction-pooling proxy. `DATABASE_URL` supplies the
source connection; credentials are passed through subprocess environment,
never command-line arguments or logs. Standard database names are supported.
Prisma-only URL options are removed for the native tools; unsupported connection
options fail explicitly.

## Create an archive

Set `SWING_BACKUP_DIR` to an absolute path on a private persistent disk outside
the source checkout. Then run:

```sh
npm run db:backup
```

The command writes a PostgreSQL custom-format dump and a JSON size/SHA-256
manifest. Files start with private permissions and a `.partial` suffix; a dump
is finalized only after successful `pg_dump` and archive-listing checks. No older
backup is overwritten or deleted. An archive without its manifest is incomplete.
Source rows, immutable research, jobs, read state, preferences and feedback are
included. Calendar files and environment configuration need separate backups;
secrets must be handled through your secure configuration store.

Keep another copy on encrypted storage away from the application host. The dump
contains private application data and is not encrypted by this command. A daily
backup schedule and retention policy should be chosen after a restore drill;
copy the manifest together with the archive. This tool does not silently prune
older backups.

## Restore into an empty, separate database

Create a new empty database with the required PostgreSQL extensions/permissions.
Keep the original `DATABASE_URL` in the environment and set `RESTORE_DATABASE_URL`
to the new target. Do not run Prisma migrations on the target before restoring;
the archive contains the schema and migration history.

```sh
npm run db:restore -- /absolute/path/to/swing-....dump --confirm-empty-target
```

The command checks the archive's manifest and SHA-256, rejects the source
host/port/database as the target, and refuses a target containing application
relations. Restore runs in one transaction and does not use `--clean` or drop
existing objects. DNS aliases cannot establish that two endpoints differ, so
select a genuinely separate empty database; the empty-target check is an
additional guard. Raw provider/database errors and credentials are not printed.

After restoration, validate row counts and application reads against the new
database, then deliberately update application configuration and restart web and
worker if recovery is desired. Do not point the running worker at a restored
snapshot during a drill: pending/retry jobs in an archive are operational state,
not a request to replay provider calls during verification. This procedure has
not yet been exercised.
