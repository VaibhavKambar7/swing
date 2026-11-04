# Swing

A personal Indian stock research assistant built with Next.js, a persistent TypeScript worker, and PostgreSQL/Prisma. Manual commands fetch announcement RSS into a deduplicated inbox and match issuer headings to a configured stock universe. The app frontend is the delivery channel for alerts and reports. Email and Telegram delivery are out of scope.

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

## Research workspace and review state

Run `npm run dev` and open `http://localhost:3000`. The UI reads your existing
Prisma database. It does not require provider credentials, fetch announcements
or prices, run AI, or enqueue jobs. Explicit review controls save read/unread
state; simply viewing or prefetching a page never marks it read.

- `/`: overview, recent records, collection recency, reports, and failures.
- `/inbox`: announcements and movement signals with stock, type, priority, review-state, and
  page filters; each item is filtered against its latest stored assessment.
- `/inbox/announcement/:id` and `/inbox/movement/:id`: source links, descriptions,
  research history, risks, uncertainties, and timestamps.
- `/briefings` and `/briefings/:id`: stored morning/closing Markdown reports and
  linked post-open assessment history. These views never regenerate reports.
- `/system`: database readability, a bounded read of worker `/health/status`,
  job state/failures, and source timestamps. No jobs are retried or recovered.

Missing records, unassessed research, stale/unknown collection, database errors,
and an unreachable worker have separate states. Source times are displayed in
IST. Collection recency is not source completeness or a guarantee of live data.
The UI never replaces unavailable data with fixtures. Source HTML is displayed
as text, report HTML is not enabled, and source links permit HTTP(S) only.

This slice uses the application's local loopback access and does not add browser
sign-in. Read state belongs to one server-owned personal workspace. Apply the
`20261104060000_workspace_read_state` migration before using review controls.
Announcements, movements, and reports have explicit Mark read / Mark unread
buttons on their detail pages, unread navigation counts, and unread indicators.
The research inbox supports unread filtering. A new research assessment or
post-open report assessment resurfaces its parent item as unread. A stale form
cannot mark a newer assessment read. Raw sources and research history stay intact.
Feedback and alert preferences are described below. Migration application
and runtime validation of review state are deferred.

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
`announcements.pipeline`, `movements.research`, `briefings.morning`, and
`briefings.closing`, and `briefings.reassess`. Payloads must be empty except
analysis `limit`, pipeline `analyze`/`analysisLimit`, or movement `signalId` and
optional `analyze`, or briefing `sessionDate`, described below. Use a unique dedupe key for a new operation. Reusing a key with
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
news sources, price polling, and alert delivery are not added by this scheduler.
Morning/closing reports and post-open reassessment are separately enabled below.

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
AI or deliver notifications. It atomically enqueues one deduplicated evidence-
linking job with the signal, as described below. Unknown calendar coverage is a failing
CLI check; other skipped cases are normal explicit outcomes. Live market-data
suitability and calendar configuration remain required for operational use.

### Movement evidence and research

Movement detection now saves an associated `movements.research` job atomically
with its signal. The worker links context without calling AI by default. It does
not enqueue repeated jobs for repeated detection of the same source event. A
completed linking job is not automatically replayed when a later filing arrives;
rerun the command below or enqueue an explicit new job to refresh context.

```sh
# Attach available evidence only; no provider key required:
npm run movements:research -- SIGNAL_UUID
# Explicit Gemini research (uses quota and requires configured access):
npm run movements:research -- SIGNAL_UUID --analyze
# Or use the durable queue:
npm run jobs:enqueue -- movements.research manual-movement-1 '{"signalId":"SIGNAL_UUID","analyze":true}'
```

The source quote snapshots must exist and match the signal's instrument, prices,
provider and timestamps. Filings must be matched to the same stock, have a
current-rule `keep`/`review` decision, have a known publication time, and have
been discovered by the requested research time. The association window runs from
24 hours before the observed move through at most 30 minutes after it, bounded
by research time. The latest five distinct filing URLs are selected from up to
thirty candidates. Other stocks, routine filings, unknown publication dates and
out-of-window filings stay in the inbox but are not attached as timed evidence.
This stage uses the existing announcement RSS source, not a new external news
search or full-filing fetcher.

Evidence links are deduplicated by signal/URL. Announcements published after the
move are labeled as such. A `knownAtMove` flag separately distinguishes filings
this system discovered only after the move, even if published earlier. A time association never establishes causality:
`catalystVerified` stays false and no verified catalyst is filled in. When there
is no eligible announcement, the input contains just the observed movement and
research must leave the catalyst unknown; this does not prove no catalyst exists.

Optional AI input includes exact stored prices, source times/IDs, quote age at
research time, provider delay uncertainty, and bounded untrusted filing text.
It cites only server-supplied evidence IDs and must cite the movement itself.
Malformed classifications/citations are rejected. Structured output validation
does not verify the factual accuracy of generated prose. The saved `analyses`
record includes input snapshot/hash, provider/model/prompt version, research
priority, uncertainties and evidence context. No alerts, trades or delivery
records are created.

Identical evidence and movement inputs reuse completed research even as wall
clock age increases. New evidence or model/prompt changes can produce a new
analysis while preserving earlier versions. The generalized Gemini prompt uses
announcement prompt version v2 so prior v1 records remain historical. Failures
stay retryable without a fake successful analysis; unsupported/missing movement
sources fail the queued task explicitly. Source context is rechecked before
saving output. No automatic price polling or scheduled AI budget is added here.

## Morning briefing

Morning reports assemble stored filings and existing pre-cutoff research without
making a new AI call. Generate and read the report in your terminal:

```sh
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run briefings:morning
# Backfill a stored-data report for a specific covered trading date:
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run briefings:morning -- --date 2026-11-03 --json
```

The report has a fixed **08:45 IST cutoff**. Its overnight window starts at the
previous covered session's close, including intervening weekends/holidays. If
prior-session calendar coverage is missing, it explicitly uses a limited 24-hour
fallback. Only active-universe NSE filings discovered, matched and filtered by
the cutoff are eligible; publication time must also fall in the window. Undated
filings are counted as excluded rather than assigned a made-up publication time.
Research must have been saved by the cutoff under the current prompt version.
Later filings, later processing and later model output do not leak into the
report. Historical reconstruction uses current stock-universe membership, not a
historical membership database.

The report contains up to twenty filings from fifty recent candidates, ordered
by existing research priority and publication time. A JSON watchlist excludes
items classified IGNORE; unassessed filings are marked as needing review.
Candidate/report limits and unavailable research remain visible. Stored research
is unverified, and this report supplies no price prediction or buy/sell order.
It does not invent a results calendar, global-market sentiment or external news:
these sources are explicitly marked as not configured.

Reports are immutable `daily_briefings` records keyed by kind/trading date/report
version, with JSON, readable Markdown, source-window metadata and generation time.
Retries and concurrent calls reuse the existing report. A manual backfill or
delayed queued run after opening is labeled as generated late; it does not claim
to have been delivered before the market opened. Generation before the cutoff,
on a closed date, or for unknown calendar coverage fails explicitly. Sessions
opening at/before 08:45 are not treated as supported pre-market briefings.

For automatic generation, set `WORKER_SCHEDULER_ENABLED=true` and
`WORKER_MORNING_BRIEFING_ENABLED=true` with a maintained calendar. The worker
enqueues one `briefings.morning` job at/after 08:45 and before that day's first
opening. Restarts in this pre-open window catch up once; restarts after opening
do not create a new morning job. The job is independent of whether an announcement
pipeline is busy. A scheduled job delayed past opening can still complete with
the late-generation label. Generation does not wait for a fresh source request.

Source collection is labeled unverified when no successful announcement pipeline
was recorded before cutoff, or stale when that success was over 75 minutes old.
A recent success establishes collection activity, not complete or real-time
upstream coverage. No eligible stored filings does not prove that no developments
occurred. Reports are stored immutably and can be read through the CLI or the website
briefings views.

## Preliminary market summary

The closing report assembles stored prices, movement triggers, company filings,
and existing research without fetching data or calling AI:

```sh
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run briefings:closing
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run briefings:closing -- --date 2026-11-03 --json
```

Regular-session cutoff is **15:45 IST**. For special sessions it is the later
of 15:45 and fifteen minutes after the final close, including a cutoff crossing
midnight. Closed dates and unknown calendar coverage are not invented as trading
days. Generation before the cutoff fails; manual historical generation remains
bounded by the original information cutoff. The calendar date on the report is
the trading session date, even when its cutoff is on the next date.

Every report is explicitly **preliminary**. The current provider cannot establish
official closing prices or final daily candles. For each of up to one hundred
tracked stocks, it inspects the latest Yahoo retrieval known by cutoff, including
its database recording time. A suitable near-close price must be in the final
five minutes of the last trading session; it remains an unverified observation.
Missing, out-of-window or clock-skewed quotes stay unavailable, and a missing
latest quote does not cause a fallback to an older one. Quote ages are measured
at cutoff, not advertised as fresh live prices. Supplied daily volumes retain
their unknown-completion label; no unusual-volume ratio is invented.

The summary lists up to fifty recorded intraday movement triggers and twenty
same-day company filings. Trigger percentages describe their original 5–6-minute
windows, **not daily gainers or losers**. Filings include pre-market disclosures
from that IST calendar date; late publication/discovery/filtering, late price
imports, and research saved after cutoff are excluded. Existing model summaries
remain unverified and announcements are possible context, not established causes.
The JSON research watchlist excludes IGNORE classifications. Nifty/Sensex
performance, verified daily-return rankings, external news and unusual-volume
analysis remain explicitly unavailable. Report limits and missing next-session
calendar coverage remain visible rather than implying market-wide completeness.

Reports share the immutable `daily_briefings` store under kind `closing`, with
their own version/date key, separate from morning reports. Concurrent generation,
retries and CLI reads reuse the stored report instead of creating duplicates or
silently upgrading it with later data. A new verified/final data methodology would
need an explicit new report version; running this command later does not make a
preliminary report final.

To schedule, enable `WORKER_SCHEDULER_ENABLED=true` and
`WORKER_CLOSING_BRIEFING_ENABLED=true` with a maintained calendar. The worker
enqueues one `briefings.closing` job when due, independent of an active ingestion
pipeline. Restarts can catch up later on the cutoff's local date; they do not
replay a backlog of earlier dates. A cross-midnight special-session report keeps
the previous trading date. If both an earlier cross-midnight report and the
current day's summary were missed, the planner favors the current day's due
summary. Explicit queueing uses `{ "sessionDate": "YYYY-MM-DD" }` and the normal
job runner. Reports are visible in the website briefings views.

## Post-open watchlist reassessment

Reassessment reads a stored premarket watchlist and stored quote observations;
it makes no source requests, AI calls, trades or deliveries:

```sh
MARKET_CALENDAR_FILE=config/market-calendar.local.json npm run briefings:reassess
# Or explicitly enqueue with a date while its window is active:
npm run jobs:enqueue -- briefings.reassess manual-post-open-1 '{"sessionDate":"2026-11-03"}'
```

For regular sessions the supported evaluation window is **09:20 inclusive to
09:30 exclusive IST**. Special sessions use five to fifteen minutes after their
first opening, capped by that session's close. Very short, closed, unknown or
expired sessions are not treated as valid reassessment windows. The matching
morning-v1 report must exist and have been generated before opening, with
a pre-open information cutoff. A report generated after opening is not passed
off as a genuinely premarket watchlist.

Candidates are deduplicated from that report's watchlist and restricted to
currently active NSE universe equities. Inactive/unavailable symbols are reported
as skipped. The latest known Yahoo snapshot is used without falling back from
a missing quote. Source and retrieval timestamps must be known by evaluation,
with no clock skew; current quote age must be at most two minutes and its source
time at least four minutes after opening. The opening reference is the earliest
reliable stored quote in the first minute after opening, fresh at retrieval. It
is an *observed opening reference*, not a verified official exchange opening.
Missing or incompatible data yields `PENDING_DATA` with a reason.

With suitable observations, the initial rules yield `CAUTION` for a rise or fall
of at least 5% since that opening reference; smaller moves yield `WATCH` for
further research. Decimal comparisons occur before rounding displayed percentages
to eight places. No buy/sell or BUY CANDIDATE instruction is emitted. A verified
previous close, valuation, liquidity baseline and entry/risk plan are unavailable;
the overnight gap remains null rather than computed from an unverified daily bar.
Provider delay remains unknown even for recent source timestamps.

Results are immutable `post_open_assessments` linked to the morning report and
stock, including rule version, snapshot IDs, timestamp metadata and limitations.
Repeating unchanged inputs/status returns the existing assessment. A new quote or
status change, including a quote becoming stale, creates a new revision while
preserving earlier results. Wall-clock age alone does not create duplicate rows
while the rule result is unchanged. Returned `assessedAt` identifies when a reused
record was originally evaluated; `evaluatedAt` identifies the current request.

To schedule checks, set `WORKER_SCHEDULER_ENABLED=true` and
`WORKER_POSTOPEN_ENABLED=true` with a maintained calendar and a real morning report.
One deduplicated job per minute can run in the supported window (up to ten slots
for a regular session), allowing missing data to be reassessed as observations
arrive. Retries after the window closes fail explicitly rather than pretending
to be a timely opening assessment. There is no automatic price importer in this
feature; fresh stored quotes must be supplied separately. Scheduling alone does
not resolve network access or create a verified price feed.

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
| `WORKER_MORNING_BRIEFING_ENABLED` | `false`; generate a stored 08:45 IST report when the scheduler is enabled |
| `WORKER_CLOSING_BRIEFING_ENABLED` | `false`; generate a preliminary end-of-session summary when scheduling is enabled |
| `WORKER_POSTOPEN_ENABLED` | `false`; reassess the morning watchlist in the 5–15 minute post-open window |
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
report delivery is a separate step. Redis/BullMQ is deferred.

## Frontend alert preferences and watchlist

Apply `20261104061000_workspace_preferences` for this slice. `/watchlist` saves
stocks from the configured active research universe. It does not change universe
membership or import new market data. Removing a watched stock preserves sources,
research, and read state. Stocks that leave active coverage stay visible as such.

`/settings` saves alert categories and research priorities for the personal
workspace. `/alerts` applies those preferences to stored research and reports;
`/inbox` continues to show the complete research record. Defaults show Investigate,
Watch, and daily reports. Unassessed items are opt-in. Ignore and routine notices
remain in the research inbox. The watched-only preference applies to research
alerts; daily reports remain market-wide. Turning categories off hides them in
this feed without discarding records or review history. This is frontend-only
filtering, with no email/Telegram delivery, push notifications, or worker changes.
Runtime verification and migration application are deferred.

## Research usefulness feedback

Apply `20261104062000_research_feedback`. Research and report detail pages accept
Useful / Not useful with an optional 500-character note. Each workspace has one
editable choice per item and reviewed version. New assessments start without
feedback; earlier choices stay in history. Clearing feedback removes only the
current version’s choice. A stale form asks you to refresh instead of attaching
feedback to a version you have not reviewed. `/feedback` shows saved totals and
the latest 50 choices. This is subjective usefulness, not return measurement or
automatic model training. Feedback is separate from read state and source data.
Runtime validation and migration application are deferred.

## Scheduled price collection — Part 6.6

Code is implemented; live provider validation remains deferred. Automatic price
collection defaults to disabled. After validating coverage/timestamps, configure
`WORKER_SCHEDULER_ENABLED=true`, `WORKER_PRICES_ENABLED=true`, a maintained calendar,
and `WORKER_PRICE_SYMBOLS=TCS,INFY` (at most 20 configured active NSE equities).
`WORKER_PRICE_HISTORY_DAYS` defaults to 7. The small explicit list is independent
of the frontend watchlist and does not claim Nifty 500 coverage.

During each known trading session, the scheduler enqueues one `prices.collect`
job per selected stock per five-minute slot, plus two post-close slots before
the closing report. Slot keys survive restarts and serialize scheduler replicas.
Stocks already having pending/running/retry collection work do not build a new
backlog. Expired scheduled jobs skip provider access; a missed polling slot cannot
be reconstructed. Each job imports immutable observations and runs same-session
movement detection. The existing detector atomically queues evidence linking;
AI remains separately opt-in. Retries are bounded and provider requests respect
worker shutdown. A delay remains unknown even when a source timestamp is recent.

Per-stock collection checkpoints record actual successful imports separately
from scheduler ticks and jobs that succeeded by skipping expired work. `/system`
shows both times. Quote omissions and movement skip reasons remain in checkpoint
metadata. Closing captures do not guarantee complete final exchange prices.
The adapter remains replaceable; this adds no Kite credentials or integration.
No live requests, migrations, builds, or tests were run for this coding subpart.

## Frontend update checks

The open workspace checks `/api/workspace/activity` every 30 seconds while visible
and online, backing off to at most two minutes after failures. It reads stored
records and preference-filtered unread counts only; it never contacts data or AI
providers. The header distinguishes unavailable update checks from zero unread
alerts. Tabs resume checks when visible or back online; requests do not overlap.

New stored activity refreshes the overview and list views when forms have not
been edited or focused. Detail/settings pages offer an explicit refresh button
so drafts are not replaced automatically. Read/unread and feedback still require
explicit saves. These are in-app updates while the app is open, not browser push
notifications or guaranteed real-time delivery. Live operation and UI verification
remain deferred. The local single-workspace access model is unchanged.
