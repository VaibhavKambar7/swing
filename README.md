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
or an explicitly enqueued analysis job. Scheduled pipelines invoke AI only when
`WORKER_SCHEDULER_AI_ENABLED=true` is explicitly configured.
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
seconds; queued jobs provide bounded retries and the optional scheduler described
below creates pipeline jobs. Missing
credentials fail explicitly; there is no fabricated or fixture result fallback.

## Database job runner

The persistent worker polls PostgreSQL for jobs. Automatic scheduling is disabled
by default; it can be enabled as described below. Run `npm run worker` (or `worker:dev`) and
enqueue a job explicitly:

```sh
npm run jobs:enqueue -- database.check manual-db-check-1
npm run jobs:enqueue -- announcements.match manual-match-1
npm run jobs:enqueue -- announcements.filter manual-filter-1
# Explicit AI use; requires the configured provider and may consume API quota:
npm run jobs:enqueue -- announcements.analyze manual-research-1 '{"limit":1}'
```

Supported kinds are `database.check`, `announcements.fetch`,
`announcements.match`, `announcements.filter`, `announcements.analyze`, and
`announcements.pipeline`. Payloads must be empty except analysis `limit` or
pipeline `analyze`/`analysisLimit`, described below. Use a unique dedupe key for a new operation. Reusing a key with
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
repeated. The runner never promises exactly-once API calls.

## Automatic announcement scheduling

First configure a maintained NSE calendar, seed your stock universe, apply
migrations, and ensure the feed is reachable. Then enable scheduling:

```sh
MARKET_CALENDAR_FILE=config/market-calendar.local.json WORKER_SCHEDULER_ENABLED=true npm run worker
```

The worker reloads the calendar on each scheduler tick (default ten seconds).
During a known trading session it schedules one pipeline per five-minute window,
anchored to that session's opening time. At all other covered times, including
holidays/weekends and gaps between special sessions, it uses one window per IST
clock hour. At transitions, such as 15:30 close, an off-hours run can happen
immediately; subsequent runs follow hourly boundaries. Unknown calendar coverage,
missing files, or invalid files stop new scheduling and degrade scheduler
readiness. Manual jobs can still run. Synthetic example calendar data is never
loaded implicitly.

Each pipeline executes fetch/store → match → filter → optional research, in that
order. Later stages do not run after an earlier failure. Pipeline jobs use the
normal retry/lease machinery; retries start from fetch, and existing storage,
matching, filtering and research deduplication make repeat processing safe for
database records. There are no separate child jobs or durable per-stage
checkpoints. Source requests and provider calls can repeat after an interruption.

Slot keys live in PostgreSQL. Repeated ticks, worker restarts and multiple
scheduler replicas cannot create duplicate scheduled jobs for a slot. A locked
scheduler checkpoint serializes replicas. While a pipeline is pending, running or
retrying, newer slots are skipped rather than building a backlog. If it finishes
within the current slot, that slot can then be scheduled. Restarting schedules
only the current window, not a burst of missed historical checks. Manual pipeline
enqueueing is explicit and can overlap with another pipeline; avoid doing that
while the scheduler is running.

Research in scheduled pipelines is separately disabled by default. Set
`WORKER_SCHEDULER_AI_ENABLED=true` to opt in, with a Gemini key and API access.
`WORKER_SCHEDULER_AI_LIMIT` defaults to one provider attempt per pipeline attempt
(range 1–20), not a daily quota. Retries and many scheduled windows can consume
additional API quota. Missing AI configuration fails the pipeline visibly when
the research stage is reached. Leave AI disabled to collect and classify filings
without model use.

To enqueue a full pipeline manually without enabling a schedule:

```sh
npm run jobs:enqueue -- announcements.pipeline manual-pipeline-1
# Explicitly include research:
npm run jobs:enqueue -- announcements.pipeline manual-pipeline-ai-1 '{"analyze":true,"analysisLimit":1}'
```

`WORKER_SCHEDULER_TICK_MS` can be 1000–60000. `/health/ready` reports the scheduler
as `disabled`, `up`, or `down`. Scheduler health means tick/enqueue operations
work; individual failed pipelines remain visible in jobs and worker logs. The
current schedule monitors the implemented announcement RSS source only. Separate
news sources, price polling, daily briefings, and alert delivery are not added
by this scheduler.

## Experimental free market data

The provider-neutral `MarketDataProvider.getSnapshot()` interface returns a
quote and daily candle history in one request. The first adapter uses Yahoo's
unofficial chart endpoint for NSE equities. It is experimental: live access,
current Indian-stock coverage, upstream usage conditions and source adjustment
semantics still require verification. It is not an official exchange feed or a
guaranteed real-time service. No authentication, cookie spoofing or fallback
scraping is implemented.

```sh
npm run prices:check -- TCS
npm run prices:check -- RELIANCE --days 30
```

Supply the plain NSE symbol, not a `.NS` suffix. The adapter maps it to Yahoo's
provider symbol and checks response identity, INR currency and NSE exchange
metadata. Only NSE equities are supported; index/BSE symbol mappings are not
inferred. History is requested for 1–365 **calendar days**, not a guaranteed
number of trading sessions. Output includes actual received candles and skipped
bar counts. Empty history and a missing quote remain explicit. The command exits
nonzero if there is no quote or a request/validation failure. A returned stale
quote is valid inspection output, not evidence of a current trading price.

Quotes preserve market time separately from retrieval time and report their age.
`freshness` is `recent` (at most five minutes old), `stale`, or `clock_skew`; the
provider's actual distribution delay remains `unknown` even for a recent quote.
Excessively future timestamps are rejected. Missing quote metadata is never
replaced by a candle close or the retrieval time. Off-hours prices can naturally
be stale. This freshness flag does not claim the market is currently open.

OHLC prices and volumes are exposed as strings rather than computed returns.
Invalid/null OHLC bars are skipped; missing or unsafe volumes remain null.
Misaligned arrays, duplicate/non-monotonic timestamps, inconsistent instruments
and malformed responses fail explicitly. Daily bars have
`priceBasis: provider_native_unverified` and `completion: unknown`: the adapter
does not assert that today's bar is final or that historical adjustments are
understood. A separate adjusted-close value is retained when supplied. JavaScript
has already parsed the provider's JSON numbers; these strings do not restore
precision absent from that response. Do not mix these values with a verified
adjusted/unadjusted return methodology until that source behavior is established.

Requests use the inherited proxy, TLS verification, a 15-second timeout, no
redirect following, and a 2 MB response limit. Cloud network settings must allow
`query1.finance.yahoo.com`. HTTP failures/rate limits and invalid data produce safe
error codes without raw response bodies. Fixtures test normalization and transport
behavior only; there is no runtime fixture fallback. Checks do not write prices
to the database, create signals, call AI or schedule polling. Use the separate
import command below for persistence and the detector for stored observations.
Automatic price polling is a separate subsequent step.

### Persisting market observations

```sh
npm run db:migrate
npm run universe:seed
npm run prices:import -- TCS --days 30
```

Imports require an existing active NSE equity with `inUniverse = true`; unknown
or disabled stocks are rejected before fetching. The response's stock, provider
and requested range must match the request. Quotes and daily bars are validated
again at the storage boundary, then saved atomically in `market_snapshots` and
`market_candles`. Inspect them using `npm run db:studio`. A failed fetch or
invalid snapshot does not insert a successful observation.

Snapshots are immutable retrievals. A hash of the normalized snapshot (including
retrieval time) deduplicates identical reimports, including concurrent writes.
A later retrieval is a new observation even when the source quote hasn't moved.
Revised candle values remain alongside earlier observations rather than silently
overwriting history. This initial design stores the returned candle window for
each retrieval; it prioritizes a clear audit trail over compact revision storage.
Order observations by `retrievedAt`, then `recordedAt`/ID for ties, rather than
assuming the most recently inserted row has the newest source data.

Prices use PostgreSQL `numeric(38,18)` and volumes use nullable `bigint`. Values
that would round, overflow or violate OHLC bounds are rejected before insertion.
Decimal strings are normalized without converting through JavaScript numbers.
This preserves the adapter's supplied precision, not precision already lost by
the provider's JSON numeric representation. Missing quotes/volumes/adjusted
closes remain null. Candle session dates use IST; timestamps use UTC instants.
Incomplete/unknown bars are never marked final, and provider-native price basis
remains unverified.

Quote age and freshness are checked against retrieval time before storage.
`quoteFreshness` is a historical label **at retrieval**, not a promise that the
stored quote is fresh now; consumers must recompute age from `quoteTime` before
using it. No movement signal, model call, scheduled price job or trading action
is created by importing observations. Live Yahoo access is still a separate
environment/provider verification requirement.

### Detecting movements from stored quotes

After importing at least two suitable quote observations, run:

```sh
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run prices:detect -- TCS
```

The initial version flags observed moves of at least **2% in either direction**
over a five-minute quote window. The reference must be at or before the target
five-minute point, within sixty seconds of it (a total source-time gap of 5–6
minutes). This is an initial research trigger, not a buy/sell rule. Comparisons
use decimal arithmetic before rounding the reported percentage to eight places.
Signal/reference prices retain the full stored numeric(38,18) precision.

Detection requires a known open session from the maintained calendar. The latest
retrieval must have a quote whose source time is in that session and no more than
five minutes old **at detection time**. Future observations, missing latest
quotes, stale references at retrieval, different instruments/providers/symbols/
currencies, overnight baselines, and large source-time gaps are rejected. The
detector does not fall back to an older retrieval if the latest one has no quote.
Daily candles, adjusted closes, volume, benchmarks and sectors are not used in
this version. Insufficient observations return a named skipped reason rather
than inventing a comparison.

Qualifying results are stored as `movement` records in `signals`, with the
detector version, percentage, source timestamps and both snapshot IDs. Provider
delay remains unknown and the context records that source quality is unverified.
There is one signal per instrument/provider/symbol/current source timestamp and
detector version: retries, concurrent detections and re-fetching the same quote
cannot create extra signals. Later price/reference revisions at that same source
timestamp do not rewrite an existing signal. Duplicate results report the
persisted assessment, not a replacement calculation. There is no cooldown across
different quote timestamps yet.

The command reads the database only for prices: it does not fetch quotes, invoke
AI, create jobs or deliver notifications. Announcement/evidence matching and
research integration are separate work. Unknown calendar coverage is a failing
CLI check; other skipped cases are normal explicit outcomes. Live market-data
suitability and calendar configuration remain required for operational use.

## Operational checks and restart recovery

Inspect persisted job state independently of whether a worker is running:

```sh
npm run jobs:status
```

The command returns counts for every job state, due jobs, expired running leases,
the ten latest terminal failures, last successful pipeline completion, and
scheduler checkpoint timestamps. It is read-only: inspecting an expired job does
not recover it. A successful query exits zero even if failed jobs exist; inspect
`hasFailedJobs`, counts and error codes. Query failure exits nonzero. Payloads,
dedupe keys, lease tokens, provider inputs and connection details are omitted.
Unknown job kinds and non-code error text are masked in this status output.

The worker's internal `GET /health/status` endpoint adds runtime information:
startup time, active job ID/kind/attempt, recent database/queue/scheduler check
times, and the latest safe scheduler error code. It returns HTTP 200 when the
worker is ready and 503 when degraded. `/health/ready` remains the smaller
readiness check; `/health/live` reports that the process responds. Database and
idle queue/scheduler check freshness affect readiness; an active job can remain
healthy while executing longer than one poll interval. Historical job failures
are reported separately and do not automatically mark the worker down.

On restart the worker reads the existing PostgreSQL queue; it does not reset job
state or create replacement keys for completed work. Unexpired running leases
remain owned until expiry. An expired lease is recovered on a subsequent poll,
then waits for retry backoff unless its attempt budget has been exhausted.
`jobs_recovered`, `job_started`, and `job_finished` structured events make these
transitions visible. Discovery timestamps, feed deduplication, input hashes and
research uniqueness survive retries. At-least-once processing still permits
repeated external API calls; database deduplication is not a guarantee of exactly
one provider request.

If monitoring is degraded, inspect status and worker logs, fix the reported
calendar/network/database/provider configuration, and let retries run. The
scheduler reloads its calendar on each tick; changing environment variables
requires a worker restart. Terminal failed jobs are retained for inspection;
after fixing their cause, explicitly enqueue a new operation with a new key if
needed. Do not reset the whole queue or delete database data to recover a worker.
When restarting after a hard kill, allow the two-minute lease plus retry delay
before expecting interrupted work to resume. Graceful termination requests stop
new claims and use the eight-second shutdown deadline described above.

## Indian market calendar

The calendar engine describes NSE equity regular sessions in `Asia/Kolkata`:
09:15 inclusive to 15:30 exclusive, Monday–Friday except configured holidays.
Pre-open and closing auctions are outside this regular-session definition.
Explicit special sessions override holidays/weekends; empty special-session
windows close a day. Multiple ordered, non-overlapping sessions are supported.
Calendar calculations do not depend on the machine's timezone.

Provide a maintained local JSON file through `MARKET_CALENDAR_FILE` or the
check command's `--file` argument. There is no default official holiday list.
`config/market-calendar.example.json` is an **illustrative synthetic template**,
not actual exchange dates. Replace its dates, source, coverage and entries using
the official NSE equity *trading* calendar and subsequent special-session notices
before operational use; settlement/bank holidays are not interchangeable.
You can keep your maintained file at the ignored
`config/market-calendar.local.json`. In the file:

- `source` records the official calendar/notices used and their update date.
- `coverageStart` / `coverageEnd` specify an inclusive date range in YYYY-MM-DD.
- `holidays` contains `{ "date": "YYYY-MM-DD", "name": "..." }` entries.
- `specialSessions` contains a date, name, and `sessions` array of
  `{ "open": "HH:MM", "close": "HH:MM" }` IST windows. Use `[]` for a closure.

Dates outside coverage are unknown, never assumed open or closed. Invalid dates,
duplicate definitions, reversed/overlapping session windows, and excessive
coverage are rejected. Holiday/special-session definitions must lie inside
coverage. A special-session override on a holiday is intentional and allowed.
The engine finds the next opening only inside known coverage and reports when
coverage is exhausted. It does not fetch calendar updates automatically.

```sh
# Illustrative code check only — uses synthetic calendar entries:
npm run market:check -- --file config/market-calendar.example.json --at 2026-11-03T09:15:00+05:30
# Operational use, after providing your maintained calendar:
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run market:check
```

`--at` accepts an ISO timestamp with seconds and an explicit `Z` or numeric UTC
offset. Output includes the IST date, day kind, session phase, current/next session
in UTC and IST, source, and coverage. Missing configuration, invalid files, or an
unknown current date produce a failing exit code. This is a standalone engine;
the optional scheduler consumes this engine, without restricting explicit manual
operations.

## Health checks

| Endpoint / command | Meaning |
| --- | --- |
| `GET /api/health/live` on port 3000 | Web process is responding |
| `GET /api/health/ready` on port 3000 | Database and worker are ready; otherwise HTTP 503 |
| `GET /health/live` on port 3001 | Worker process is responding |
| `GET /health/ready` on port 3001 | Database heartbeat is healthy and queue polling works |
| `GET /health/status` on port 3001 | Runtime checks, job counts, expired leases and recent failures |
| `npm run db:check` | Verify a real PostgreSQL query through Prisma |
| `npm run jobs:status` | Read persisted queue status without starting a worker |

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
| `WORKER_SCHEDULER_ENABLED` | `false`; enable announcement scheduling explicitly |
| `WORKER_SCHEDULER_TICK_MS` | `10000`, permitted range 1000–60000 |
| `WORKER_SCHEDULER_AI_ENABLED` | `false`; scheduled research is separately opt-in |
| `WORKER_SCHEDULER_AI_LIMIT` | `1`, range 1–20, per pipeline attempt |
| `MARKET_CALENDAR_FILE` | Maintained calendar file required when scheduling is enabled |
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
Optional market-aware scheduling runs sequential announcement pipelines;
persistent work stays outside Next.js request handlers. Additional sources,
briefings and delivery are separate steps. Redis/BullMQ is deferred.
