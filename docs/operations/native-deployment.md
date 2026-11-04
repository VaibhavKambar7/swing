# Native process deployment (no Docker)

These are deployment templates, not an installed or validated deployment. Implementation checks may run static analysis, builds and isolated tests.
Real migrations, deployments, provider checks and backups require the later operational phase.
Use this procedure only during the later validation/deployment phase.

## Runtime layout

- `/opt/node24/bin/node`: a current Node 24 release supporting `--use-env-proxy`.
- `/opt/swing/releases/<commit>`: a complete checkout and its built output.
- `/opt/swing/current`: a symlink to the selected release.
- `/etc/swing/swing.env`: private runtime environment (not in Git).
- `/etc/swing/market-calendar.json`: a maintained exchange calendar.
- `/var/lib/swing/backups`: private backup destination on persistent storage.
- A PostgreSQL database reached through its direct endpoint.

Use a dedicated `swing` OS account. Keep release code owned by the administrator
and readable by the service; make only runtime/cache/backup directories writable
by `swing`. The templates bind web and worker health to loopback. For remote use,
terminate HTTPS at your reverse proxy and forward the Authorization header. Set
SWING_AUTH_USER, a random SWING_AUTH_PASSWORD (at least 24 characters),
SWING_PUBLIC_ORIGIN to the exact HTTPS browser origin, and an independent
WORKER_ACCESS_TOKEN (at least 32 characters) shared by web and worker. The app
fails closed without these secrets. Keep worker health endpoints private too.
This remains a single-owner workspace; HTTP Basic authentication is not a
multi-user account system.

## Prepare a release later

In a new release checkout, select the current Node 24 runtime and run:

```sh
npm ci
npm run build
npm run ops:prepare-release
```

The worker uses `tsx`, so this layout retains the complete dependency tree,
including development dependencies. `ops:prepare-release` copies public/static
assets into Next's standalone output. It does not build or deploy the code.
Create `.next/standalone/.next/cache` before starting the web service, and give
the service account permission to write this cache directory. Verify standalone
packaging and worker imports during the later deployment checks.

Set database and worker configuration in `/etc/swing/swing.env` with private
permissions. Configure `MARKET_CALENDAR_FILE=/etc/swing/market-calendar.json` and
`SWING_BACKUP_DIR=/var/lib/swing/backups` as needed. Keep scheduler, AI, price
collection, and report generation opt-ins disabled until their integrations have
been validated. Back up the existing database before migrations. Then, with the
intended database explicitly selected, run:

```sh
npm run db:migrate
```

This applies additive review/preference/feedback migrations as well as any older
pending migrations. It does not imply that the complete application was tested.
Do not use `prisma db push`, reset the database, or apply a backup over a live DB.

## Start services later

Review the paths/account/environment in `ops/systemd/*.service`, provision the
directories above, and install the reviewed templates into `/etc/systemd/system`.
The app's runtime user must be able to read its environment/calendar files.
After deliberately switching `/opt/swing/current` to the chosen release:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now swing-worker.service swing-web.service
npm run ops:readiness
```

`ops:readiness` checks both existing database-backed readiness endpoints and
returns nonzero if either is unavailable or degraded. It does not start services,
apply migrations, or make provider calls. `SWING_WEB_URL` and
`WORKER_HEALTH_URL` override its default loopback targets. Inspect journald logs
for safe worker/job codes; the health endpoint is not proof of provider coverage.

Only after a successful restore drill should you choose to install/enable
`swing-backup.timer`. Its template schedules an archive around 02:30 IST, with
up to five minutes of jitter and catch-up after downtime. No timer is installed
or enabled by this repository. See [backup recovery](backups.md) for separate
storage and restore instructions. Archive retention is deliberate, not automatic.

## Updates and rollback

Prepare each release separately. Stop services during the final switch so worker
and web use the same code/schema. Apply compatible migrations once, switch the
symlink, restart, and check combined readiness. Keep the previous release for
code rollback; do not roll back database schema/data automatically. Older code
must still be compatible with the migrated database. A database restore is a
separate recovery decision using a separate target, never an automatic response
to a health-check failure.

End-to-end live operation, unattended reliability, backup recovery, and hosting
remain unverified until the later test phase.
