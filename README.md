# Swing

A personal Indian stock research assistant built with Next.js, a persistent TypeScript worker, and PostgreSQL/Prisma. Manual commands fetch announcement RSS into a deduplicated inbox and match issuer headings to a configured stock universe. Website alerts are the preferred delivery direction, with email an optional later addition.

## Requirements

- Node.js 24 LTS and npm (see `.nvmrc`).
- PostgreSQL 17, either an existing local instance or Docker Compose when ready.
- Ingestion, matching and filtering need no AI or delivery credentials. The
  optional research command requires a Gemini API key.

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

This is a raw inbox: unknown companies do not prevent ingestion. Matching is a
separate operation described below. Descriptions may contain publisher HTML; treat them as
untrusted text and do not render them as raw HTML. No messages are sent, and no
automatic polling or AI analysis is enabled in this slice. Existing entries are
immutable; detecting revisions is a later feature. The first run imports the
current feed window, which may include older announcements. Raw source fields are
immutable; matching only updates the stock link and matching metadata.

The command uses Node 24's `--use-env-proxy` flag to respect configured HTTP(S)
proxies. Cloud network settings must allow `nsearchives.nseindia.com`. Live feed
access was blocked by the cloud proxy during implementation; the endpoint and
current feed shape still need a live smoke check once access is applied. Parser
fixtures and Prisma/PGlite integration tests cover storage and duplicate handling
without relying on external network access. A feed is only a rolling window and
does not guarantee complete historical announcement coverage.

### Feed checks and saved-file imports

Check the feed without opening a database connection or storing any entries:

```sh
npm run announcements:check
```

Set `NSE_ANNOUNCEMENTS_URL` in your local environment to override the endpoint
for the same NSE RSS source. It must use HTTPS with no embedded credentials or
fragment. Network policy still applies; this setting does not grant access. Do
not point it at a different publisher: source IDs remain namespaced as NSE.

To validate a previously saved RSS response without network access:

```sh
npm run announcements:check -- --file /path/to/saved-nse-feed.xml
# Parser/CLI demonstration using explicitly synthetic data; no database writes:
npm run announcements:check -- --file tests/fixtures/announcements.xml
```

To import a saved real NSE response, use `npm run announcements:fetch -- --file
/path/to/saved-nse-feed.xml`. This writes to the same deduplicated inbox as a live
fetch. Do not import the synthetic fixture into a real research database.
File input is explicit: a failed live request never falls back to fixture data.
Both modes enforce a 5 MB input limit. Check output reports valid/skipped counts,
missing publication dates, whether input was live or a file, and that no database
writes occurred. An empty valid feed reports zero received, which does not prove
that live announcements are available. Failure output contains a safe stage/code
and HTTP status when available, without response bodies or connection secrets.

## Stock universe and announcement matching

```sh
npm run db:migrate
npm run universe:seed
npm run announcements:fetch
npm run announcements:match
```

`universe:seed` inserts six starter NSE equities: RELIANCE, TCS, INFY, HDFCBANK,
ICICIBANK, and ATHERENERG. It is a small starting list, not an index constituent
list or investment recommendation. Repeating the seed inserts only missing
stocks and preserves existing names, active flags, and universe membership. Edit
`src/lib/instruments/starter-universe.ts` before seeding to change the starter
list; existing database records can be managed with `npm run db:studio`.

`announcements:match` works on already-stored NSE feed items, so it can run
independently of feed access. It considers only active NSE equities with
`inUniverse = true`. It matches an issuer heading such as `TCS - Financial
Results` or `Tata Consultancy Services Ltd. - Updates` to a symbol or company
name, ignoring case, punctuation and the Ltd/Limited variation. It does not infer
the issuer from names mentioned in the body or use fuzzy matching. Titles with
unrecognized structures stay unmatched. Hyphenated company names may require a
future source-specific issuer field or alias support.

Feed items have `pending`, `matched`, `unmatched`, or `ambiguous` match status, a
stock link when matched, and a check timestamp. Multiple candidate companies
produce an ambiguous result with no link. Unmatched and ambiguous items are
retained and retried on the next run after stock-list edits. Established matches
are left unchanged, including their check timestamps; changing a known match
requires an explicit database correction. The command processes the inbox in
batches and reports counts for this run. It does not promote feed items into
research signals, call AI, or deliver notifications. Relevance filtering is a
separate manual step described below.

## Announcement relevance filtering

After fetching and matching announcements:

```sh
npm run db:migrate
npm run announcements:match
npm run announcements:filter
```

The manual filter processes matched NSE announcements only for active equities in
our configured universe. It stores the latest relevance decision, reason code,
rule version, and check timestamp on each `feed_items` row:

- `keep`: subject or description contains a potentially material event cue.
- `routine`: an exact recognized trading-window, share-certificate, or Regulation
  74(5) depository-certificate subject with an absent or recognized routine body.
- `review`: unfamiliar wording, encoded content, unexpectedly large text, or a
  routine-looking title with an unrecognized body; retain it for research.
- `pending`: not yet filtered, including unmatched and ambiguous issuer records.

This is a conservative heuristic, not a financial assessment. An important-event
cue overrides routine rules. No item is deleted, and raw titles, descriptions,
links, publication/discovery times, and issuer matches are preserved. `routine`
is not the research assessment `IGNORE`; no AI call or alert is triggered here.
Review rows and reasons in Prisma Studio (`npm run db:studio`).

Repeated commands leave decisions from the current rule version unchanged,
including timestamps. Bumping `RELEVANCE_RULE_VERSION` re-evaluates older versions.
Overlapping runs update each eligible item once per version. Manually clearing a
match/decision requires setting relevance back to `pending` and clearing its
reason, version, and check time together. Decisions retain the latest result,
not a full change-history log. The rules still need validation against actual
feed samples once live NSE access is verified.

## Announcement research

Research uses Gemini's JSON API through a replaceable provider adapter. Configure
`GEMINI_API_KEY` securely in your environment or ignored `.env` file and optionally
set `GEMINI_MODEL` (default `gemini-2.5-flash`). Never commit a key. For cloud proxy
credentials, bind `GEMINI_API_KEY` to `generativelanguage.googleapis.com` and allow
that hostname in environment settings. The Node command uses the configured
HTTP(S) proxy and retains TLS verification.

```sh
npm run db:migrate
npm run announcements:match
npm run announcements:filter
npm run announcements:analyze -- --limit 5
```

Only matched, active NSE universe equities with a `keep` or `review` decision
from the current filtering rules are eligible. Routine items, unmatched items,
and unfiltered items are excluded. Research runs only through the manual command
or an explicitly enqueued analysis job; no analysis jobs are scheduled automatically.
The default limit is five provider attempts
per invocation, with a maximum of twenty. API use may consume quota or incur
charges; the provider's plan determines pricing. Model availability depends on
the account. This implementation does not select a second provider on failure.

The model receives only stock identity, bounded announcement text, timestamps,
and filtering context. It does not fetch filings, current quotes, financial
statements or valuation data. Output includes a summary, potential significance,
risks, uncertainties, and an INVESTIGATE / WATCH / IGNORE research priority.
These are machine-generated research notes, not verified facts or trade orders.
Missing timestamps and truncated text remain explicit in the stored input.
Instructions embedded in source text are treated as untrusted data. JSON schema
validation rejects malformed output, unsupported classifications and unknown
evidence IDs; it cannot establish the factual accuracy of model prose.

Validated results are stored in `feed_research` with the original input snapshot,
input hash, requested model, provider, prompt version, token counts when supplied,
and evidence links copied from the source record. They stay attached to the raw
feed item; no publication date, trade signal, or delivery record is invented.
Use `npm run db:studio` to inspect records. An identical completed request is
skipped on subsequent runs. Changed inputs, model or prompt versions can produce
new research without deleting history. Eligibility is rechecked before saving.
The unique database key prevents duplicate records; overlapping manual commands
can still make duplicate provider calls, so run one analysis command at a time.

HTTP failures, blocked/truncated generations and invalid output are not saved as
successful research. Failed items can be retried by rerunning the command. The
command returns a failing exit status if any item fails and emits safe error codes
without provider response bodies or credentials. The provider timeout is 60
seconds; retries and scheduling belong in the later job runner. Missing
credentials fail explicitly; there is no fabricated or fixture result fallback.

## Database job runner

The persistent worker polls PostgreSQL for jobs; it does not create scheduled
jobs or chain pipeline stages yet. Run `npm run worker` (or `worker:dev`) and
enqueue a job explicitly:

```sh
npm run jobs:enqueue -- database.check manual-db-check-1
npm run jobs:enqueue -- announcements.match manual-match-1
npm run jobs:enqueue -- announcements.filter manual-filter-1
# Explicit AI use; requires the configured provider and may consume API quota:
npm run jobs:enqueue -- announcements.analyze manual-research-1 '{"limit":1}'
```

Supported kinds are `database.check`, `announcements.fetch`,
`announcements.match`, `announcements.filter`, and `announcements.analyze`.
Payloads must be empty except the optional analysis `limit` (default one,
maximum twenty). Use a unique dedupe key for a new operation. Reusing a key with
the same kind, payload and attempt limit returns the existing job, including a
completed or failed job; it does not reset it. Conflicting reuse is rejected.
Inspect jobs using `npm run db:studio`; worker logs include job ID, status,
attempt and safe error code without raw payloads or error messages.

Each worker executes one job at a time. PostgreSQL atomically claims due jobs
with `FOR UPDATE SKIP LOCKED`, so multiple workers can process different jobs.
Each claim consumes one attempt and gets a unique token and two-minute lease.
The runner renews that lease every thirty seconds. Completion and renewal require
the same unexpired token; an old worker cannot acknowledge a reclaimed job.
Expired work is moved to retry, or failed when its attempt budget is exhausted.
Recovery runs before each poll. Ordinary failures retry after 5, 10, 20, ...
seconds, capped at five minutes, up to five total attempts by default. Invalid
payloads, unsupported kinds, and missing provider configuration fail immediately.
No schema migration is needed: the runner uses the existing `jobs` table.

`WORKER_JOB_POLL_MS` controls polling (default 2000, range 500–60000). Idle polls
do not increment attempts. The worker readiness endpoint includes database and
queue-poll status; an individual failed job does not mean the worker is down.
Shutdown stops new claims and signals an active handler, with the existing
eight-second shutdown deadline. Some operations cannot stop midway; if the
process exits, the lease expires and another worker can recover the job.

Execution is at least once. Lease tokens protect job state, not external side
effects: interrupted requests or lost leases can overlap with retries. Ingestion
deduplication and research uniqueness still apply, but provider calls can be
repeated. The runner never promises exactly-once API calls. Job chaining, market
calendars, and automatic schedules are separate subsequent steps.

## Health checks

| Endpoint / command | Meaning |
| --- | --- |
| `GET /api/health/live` on port 3000 | Web process is responding |
| `GET /api/health/ready` on port 3000 | Database and worker are ready; otherwise HTTP 503 |
| `GET /health/live` on port 3001 | Worker process is responding |
| `GET /health/ready` on port 3001 | Database heartbeat is healthy and queue polling works |
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
| `WORKER_JOB_POLL_MS` | `2000`, permitted range 500–60000 |
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

The worker runs health checks and explicitly queued announcement/research jobs.
Market calendars, automatic scheduling, job chaining and delivery are separate
steps; persistent work stays outside Next.js request handlers. Redis/BullMQ is
deferred.
