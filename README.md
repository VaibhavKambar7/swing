# Swing

A personal Indian stock research assistant. The application foundation and initial database schema are implemented. The first announcement ingestion slice adds a manual NSE RSS fetch and a deduplicated database inbox. Stock matching, scheduling, price monitoring, AI research, and alert delivery are still pending. Website alerts are the preferred delivery direction, with email an optional later addition.

## Requirements

- Node.js 24 LTS and npm (see `.nvmrc`).
- PostgreSQL 17, either an existing local instance or Docker Compose when ready.
- No Zerodha, AI, or Telegram credentials are needed for this task.

## Local development

```sh
cd /Users/vaibhavkambar/Desktop/m/swing
npm ci
cp .env.example .env
```

Update `DATABASE_URL` for your PostgreSQL instance. The example uses local-only development credentials and port 5434 to avoid the usual 5432 conflict.

If using Docker later, start just the database:

```sh
docker compose up -d db
```

Run the following in separate terminals:

```sh
npm run dev
```

```sh
npm run worker:dev
```

Open [Swing](http://localhost:3000). Without PostgreSQL, the web page and liveness checks still work; readiness reports HTTP 503, and the worker retries its database check every 10 seconds.

## Announcement ingestion — first working slice

Apply the new inbox migration, then fetch once:

```sh
npm run db:migrate
npm run announcements:fetch
```

The command requests `https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml`
and stores valid entries in `feed_items`. It reports received, inserted, duplicate,
and skipped counts. Repeating the command leaves already-seen entries and their
discovery times unchanged. RSS GUID is the source ID, with the link as a fallback.
Missing or invalid publication dates stay unknown rather than being replaced by
the fetch time. Malformed items are counted as skipped; malformed XML, non-RSS
responses, oversized responses, and failed HTTP requests fail the command.

This is a raw inbox: company matching happens later, so an unknown company does
not prevent ingestion. Descriptions may contain publisher HTML; treat them as
untrusted text and do not render them as raw HTML. No messages are sent, and no
automatic polling or AI analysis is enabled in this slice. Existing entries are
immutable; detecting revisions is a later feature. The first run imports the
current feed window, which may include older announcements.

The command uses Node 24's `--use-env-proxy` flag to respect configured HTTP(S)
proxies. Cloud network settings must allow `nsearchives.nseindia.com`. Live feed
access was blocked by the cloud proxy during implementation; the endpoint and
current feed shape still need a live smoke check once access is applied. Parser
fixtures and Prisma/PGlite integration tests cover storage and duplicate handling
without relying on external network access. A feed is only a rolling window and
does not guarantee complete historical announcement coverage.

## Health checks

| Endpoint / command | Meaning |
| --- | --- |
| `GET /api/health/live` on port 3000 | Web process is responding |
| `GET /api/health/ready` on port 3000 | Database and worker are ready; otherwise HTTP 503 |
| `GET /health/live` on port 3001 | Worker process is responding |
| `GET /health/ready` on port 3001 | Worker database heartbeat is healthy and recent |
| `npm run db:check` | Verify a real PostgreSQL query through Prisma |

Health endpoints expose component status only, with no credentials. The worker binds to loopback locally; Compose exposes it only inside its network. The web server also binds to loopback by default. Authentication and settings endpoints arrive in subsequent tasks; there are no credential-entry endpoints in this foundation.

## Environment

Copy `.env.example` to `.env`; never commit `.env`. Next.js, worker scripts, and Prisma use the same Next.js environment-file loader. Invalid configuration reports field names without values. Server secrets must not use the `NEXT_PUBLIC_` prefix.

| Variable | Default / requirement |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL |
| `WORKER_HOST` | `127.0.0.1`; Compose sets `0.0.0.0` internally |
| `WORKER_PORT` | `3001` |
| `WORKER_HEALTH_URL` | `http://127.0.0.1:3001`; web uses this to check the worker |
| `WORKER_HEARTBEAT_MS` | `10000`, permitted range 1000–60000 |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Compose database initialization; unused when connecting to an existing database |

For Compose, keep database settings consistent with `DATABASE_URL`. URL-encode special characters in connection-string credentials. The generated Compose URL assumes a URL-safe password; change it to an explicit encoded URL if needed. Changing initialization credentials does not update an existing PostgreSQL volume.

## Checks and builds

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run db:check
```

`db:check` requires a running database. A build needs a syntactically valid `DATABASE_URL` but does not connect to PostgreSQL. To run a production build locally, use `npm start` and `npm run worker` in separate terminals.

## Docker Compose (for later)

```sh
# All services: web, worker, and PostgreSQL
docker compose --profile full up --build -d
# Stop services while preserving database data
docker compose --profile full down
```

Docker runtime verification is deferred at the user's request. Database data persists in a named volume. Do not use `down -v` unless intentionally deleting local data. This Compose configuration is a local starting point; configure production secrets, TLS, access control, and backups before hosting.

## Structure and migrations

- `src/app`: Next.js interface and health routes.
- `src/lib/config`: validated server configuration and shared environment loading.
- `src/lib/db`: lazy shared Prisma Client with the PostgreSQL driver adapter.
- `prisma/schema.prisma`: typed models, enums, relations, and indexes.
- `src/generated/prisma`: generated client (ignored by Git and regenerated during installation/build).
- `src/workers/index.ts`: persistent worker, heartbeat, and graceful signal shutdown.
- `scripts/check-db.ts`: standalone connection check.
- `prisma.config.ts`: migration configuration.

The initial migration is `prisma/migrations/20261028000000_initial_schema/migration.sql`. Apply it to your configured PostgreSQL database when ready:

```sh
npm run db:migrate
```

`npm run db:generate` generates Prisma Client; it does not create a SQL migration. `npm run db:validate` validates the schema. Installation, builds, type checks, and tests generate the client automatically, without needing a database connection or a configured `DATABASE_URL` at install time.

For future schema changes, use `npm run db:migrate:create -- --name describe_change` against a local development database, review the SQL (including custom constraints), then use `npm run db:migrate:dev` to apply it locally. Development migration commands require a database and shadow-database access. `npm run db:migrate` uses `prisma migrate deploy` to apply checked-in migrations without a reset or shadow database. Do not edit an already applied migration.

The initial migration retains all SQL CHECK constraints. Prisma Schema cannot express these checks, so preserve them in reviewed SQL migrations and avoid `prisma db push` as a deployment workflow. The partial worker-lease index uses Prisma's `partialIndexes` preview feature, with matching pinned Prisma 7 packages.

No migration has been applied to your configured database. Tests run Prisma Migrate and Prisma Client against an isolated in-memory PGlite engine through a loopback socket; this needs neither Docker nor your real database. This initial Prisma migration targets a fresh database. If the earlier schema was manually applied elsewhere, baseline that database before using Prisma Migrate; do not reset existing data.

| Table | Purpose |
| --- | --- |
| `instruments` | Stable stock/index identity, provider token, universe membership, benchmark and sector mappings |
| `announcements` | Source identifiers, official filing links, publication and discovery times |
| `signals` | Movement or announcement triggers, detector version, exact decimal metrics, missing-data context |
| `signal_evidence` | Source links and retrieval snapshots supporting investigation |
| `analyses` | Model/prompt provenance, structured assessment, uncertainty, and usage costs |
| `alerts` | Rule-based classification, immutable message snapshot, recipient, deduplication key |
| `delivery_attempts` | Per-attempt status, Telegram message identifier, and delivery timestamps |
| `jobs` | Durable pending/retry work, attempt limits, expiring worker leases, completion state |
| `polling_checkpoints` | Independent source/scope polling cursors and health timestamps |
| `feedback` | One current Useful / Not useful choice per alert and Telegram user |
| `performance_outcomes` | 1/5/15 trading-day reference prices, benchmark returns, methodology, and missing-data reasons |

Prices and percentages use PostgreSQL `numeric` and Prisma `Decimal` objects; serialize them explicitly as decimal strings at API boundaries. Provider tokens use `BigInt` and also need explicit string serialization in JSON. Times use `timestamptz`; session dates use exchange-local `date` values (represented as UTC-midnight `Date` objects by Prisma). Missing metrics remain NULL. Telegram identifiers are text to avoid JavaScript integer precision loss. Deletions default to restrictive foreign keys, preserving research history.

Foreign keys prevent signals from referencing another stock's announcement and alerts from referencing another signal's analysis. Unique keys support deduplication and feedback upserts. Checks enforce valid prices, outcome horizons, complete results, retry bounds, and lease fields. The application must still validate external payloads, increment job attempts, claim work atomically, and update `updated_at` explicitly. The schema does not implement a job runner, outcome calculator, or provider integration.

When implemented, ingestion must create a signal and its pending job in one transaction; polling checkpoints must advance only after durable ingestion. Recover expired leases and use bounded retries. Telegram timeouts may leave delivery status `unknown`: stored deduplication keys cannot guarantee exactly-once delivery to an external API. Benchmark/sector mappings must be validated against index instruments by the ingestion layer.

The worker currently performs health checks only. Scanner, announcement, analysis, and delivery modules will be added incrementally without moving persistent work into Next.js request handlers. Redis/BullMQ is deferred.
