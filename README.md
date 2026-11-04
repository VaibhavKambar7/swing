# Swing

Personal Indian equity research using Next.js, TypeScript, PostgreSQL/Prisma and
a persistent Node worker. The app is the delivery channel: no email or Telegram.
Assessments are research priorities, never buy/sell orders. Announcement-first
research and price-movement research remain independent. Neither a movement nor
nearby news establishes a catalyst or verified investment performance.

## Run locally

Use Node **24.5 or newer within Node 24** (`.nvmrc` selects current Node 24) and
PostgreSQL 17. Docker is optional; an existing PostgreSQL instance works.

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL`, `SWING_AUTH_USER`, a random `SWING_AUTH_PASSWORD` of at least
24 characters, and an independent `WORKER_ACCESS_TOKEN` of at least 32 characters.
Keep secrets in the environment or ignored `.env`, never in Git. Set
`SWING_PUBLIC_ORIGIN` to the exact browser origin, e.g. `http://localhost:3000`.
All pages, actions and APIs require HTTP Basic authentication; the browser prompts
for credentials. Missing web secrets fail closed. Worker diagnostics require the
separate bearer token, shared with the web process. Close your browser session
to clear cached Basic credentials. This is a single-owner workspace.

When you deliberately begin database setup, review the additive migrations and
back up existing data before applying them:

```sh
npm run db:migrate
npm run dev
# Separate terminal:
npm run worker:dev
```

Open http://localhost:3000. For hosting, HTTPS and a correctly configured reverse
proxy are required; forward Authorization and preserve the public origin.
Loopback is additional isolation, not authentication. See
[native deployment](docs/operations/native-deployment.md) and
[backup and recovery](docs/operations/backups.md). These are tooling/templates;
no deployed infrastructure, real migration or backup/restore is implied.

## Frontend workflows

| Page | Use |
| --- | --- |
| `/` | Overview, collection recency, latest records and failures |
| `/alerts` | Stored research/reports filtered by your preferences and review state |
| `/inbox` | Complete announcement/movement inbox with stock, priority and review filters |
| `/inbox/:kind/:id` | Evidence, timestamps, research history, movement comparisons, read state and usefulness feedback |
| `/briefings` | Paginated morning and preliminary closing reports, with post-open reassessments |
| `/universe` | Replace membership from supplied official CSV or mapped JSON, with import history |
| `/sources` | Enable NSE/BSE, add external news searches, inspect per-source failures |
| `/watchlist` | Personal watched stocks without changing collection coverage |
| `/settings` | Frontend alert categories, priorities and watched-only selection |
| `/feedback` | Version-specific usefulness feedback history |
| `/outcomes` | Paginated pending/unavailable/observed research follow-ups |
| `/system` | Database, queue and worker diagnostics |
| `/system/prices` | Per-stock source timestamps, recency, errors and observed polling selection |
| `/system/controls` | Explicitly queue supported operations, inspect jobs and request cancellation |
| `/system/jobs/:id` | Safe job state and deliberate, audited failed-job retry |

Page loads never call market or AI providers, mark items read, or run recovery.
Explicit mutations are authorized and validated on the server. Missing records,
stale observations, unavailable services and failed writes have separate states;
there are no fixture fallbacks. Source text is untrusted and displayed as text.
Report HTML is disabled and source links allow only HTTP(S) without credentials.

Read/unread state and feedback belong to the current reviewed version. New
research resurfaces items as unread; stale forms cannot acknowledge or score a
newer version. Feedback is subjective usefulness, not model training or returns.
Alert preferences filter delivery views without deleting source/research history.
The open app checks stored activity every 30 seconds while visible/online, backs
off after failure, and offers explicit refresh on editable/detail pages.

## Maintained universe

`/universe` imports up to 2,000 supplied records. No current Nifty 500 constituent
list is assumed. Official CSV accepts `Company Name`, `Symbol`, `Industry`,
`ISIN Code` headers and quoted fields. Supply its source and effective date.
Mapped JSON uses this shape (format example, **not** a constituent list):

```json
{"source":"Official source and retrieval date","effectiveDate":"2026-11-04","members":[{"symbol":"NIFTY50","name":"Nifty 50","kind":"index","yahooSymbol":"^NSEI"},{"symbol":"TCS","name":"Tata Consultancy Services Limited","sector":"IT","benchmark":"NIFTY50"}]}
```

Optional fields include `isin`, six-digit `bseCode` and `sectorIndex`, which must
refer to an included index. Imports atomically replace coverage, preserve removed
instruments and research, reject duplicate symbols/older memberships and retain
an immutable import snapshot. Repeating an identical import is harmless.
`universe:seed` remains an optional six-stock development starter, not Nifty 500.

## Sources and research

NSE RSS is enabled by the source migration; BSE is initially disabled. `/sources`
can enable BSE and add Google News RSS searches (maximum 20 configured sources).
BSE uses the official announcements JSON endpoint and exact configured scrip
codes. NSE matches issuer headings to active NSE equity symbols/company names;
external news requires an unambiguous full company name or stock symbol in its
headline. Unmatched/ambiguous records remain in the raw inbox. Known publisher
namespaces alone are eligible for matching/filtering/research; unknown historical
publishers are not promoted by coincidence.

The pipeline fetches enabled sources sequentially, stores immutable deduplicated
items, matches, conservatively filters routine notices, and optionally researches.
Successful source imports survive another source's failure; matching/filtering
still run before the job reports partial failure. Per-source checkpoints show
actual storage success and safe errors. No source silently replaces a failed one.
BSE's window is the current IST day and at most five pages. RSS/search feeds are
rolling windows. Neither is a guarantee of complete historical/current coverage.
Live endpoint shape, access and usefulness still require validation.

Research uses Gemini's real JSON API behind `ResearchProvider`. Set
`GEMINI_API_KEY` securely and optionally `GEMINI_MODEL` (default `gemini-2.5-flash`).
Explicit research jobs and separately enabled scheduled AI can consume quota.
Collection and evidence linking do not implicitly run AI. Inputs are bounded and
untrusted; output validation rejects invalid classifications and evidence IDs.
Validated summaries, risks, uncertainty, input snapshots/hashes, prompt/model and
usage metadata are retained. Unknown timestamps and truncated input stay explicit.
The summarizer does not fetch full PDFs, financial statements or valuations.
Model prose is unverified even when schema-valid. Missing keys fail explicitly.

Movement evidence uses matched same-stock official/news records published within
24 hours before through 30 minutes after the event, discovered by research time.
After-move and not-known-at-move evidence is labelled; no causal verification is
inferred. Changed evidence can create a new immutable assessment.

## Price collection and context

`MARKET_DATA_PROVIDER=yahoo-experimental` selects the implemented Yahoo chart
adapter. Quotes and daily candles retain source/retrieval/recording timestamps,
source precision, freshness and immutable revisions. Delay, adjustment basis and
official daily completion remain unverified. Missing latest quotes do not fall
back to older usable ones. Kite is explicitly deferred: choosing `kite` produces
a configuration error, while storage, jobs and UI use provider-neutral contracts.

Automatic collection is opt-in. `WORKER_PRICE_SYMBOLS` empty selects all imported
active instruments, including mapped indexes; a comma-separated list restricts
selection. A durable rotation enqueues at most `WORKER_PRICE_BATCH_SIZE` (default
20, maximum 100) per configured slot, staggered by
`WORKER_PRICE_REQUEST_INTERVAL_MS` (default 1000, range 250–60000). Repeated ticks
cannot exceed that slot's budget. Busy stocks do not accumulate work, and expired
slots skip requests. Per-host database reservations also throttle worker calls
across processes and honor bounded Retry-After cooldowns.

`WORKER_PRICE_SLOT_MS` defaults to 300000 (five minutes), configurable in
30-second increments down to 30000. For example, 100 requests per 60-second slot
permits a five-slot rotation over 500 instruments, provided latency and provider
limits permit it. The worker reports its actual budget, slot duration and spacing
on the price diagnostics page.

At 500 stocks and the default five-minute slots/batch 20, one sweep is roughly 125 minutes. This configuration
supports full membership without promising five-minute coverage of every stock.
The detector needs same-provider, same-session fresh quotes 5–6 minutes apart and
at least a 2% change. Insufficient cadence/data explicitly produces no movement;
select a focused set or configure sufficient bounded capacity within provider
limits. Index observations supply comparisons and never trigger stock movements.

Movement context freezes mapped benchmark/sector changes using quotes aligned
within one minute at each endpoint and known by detection time. Percentage-point
differences are not verified excess returns. Prior usual volatility uses
non-overlapping same-session 5–6 minute pairs from at most 30 calendar days and
5,000 observations, requiring 20 pairs across five sessions. Missing mappings,
aligned observations, variance or history remain unavailable. Comparable
intraday volume is unavailable from this provider; no daily proxy is fabricated.

## Calendar, scheduler and reports

Set `MARKET_CALENDAR_FILE` to your maintained official NSE equity trading calendar.
`config/market-calendar.example.json` is **synthetic**, never implicitly loaded.
Supply `source`, inclusive `coverageStart`/`coverageEnd`, `holidays` with date/name,
and `specialSessions` with date/name/sessions (`open`/`close` IST HH:MM; `[]` closes
a day). Normal sessions are 09:15–15:30 IST on weekdays; explicit special sessions
override holidays/weekends. Unknown coverage is never assumed open or closed.

Master `WORKER_SCHEDULER_ENABLED` defaults false. When enabled, announcement
pipelines run every five minutes in a session and hourly otherwise. Separate
opt-ins control `WORKER_PRICES_ENABLED`, `WORKER_MORNING_BRIEFING_ENABLED`,
`WORKER_CLOSING_BRIEFING_ENABLED`, `WORKER_POSTOPEN_ENABLED`, and
`WORKER_FOLLOWUPS_ENABLED`. Scheduled AI additionally requires
`WORKER_SCHEDULER_AI_ENABLED`; its per-pipeline limit defaults one (maximum 20).

Morning reports use an 08:45 IST cutoff and previous-session-close window where
covered, otherwise an explicit 24-hour fallback. Closing reports are preliminary,
at 15:45 IST or 15 minutes after a later special-session close. They show source
and quote gaps rather than invented official closes, daily rankings or macro
predictions. Reports retain cutoffs, original generation times and immutable
methodology versions. Late generation is labelled. Around 09:20, reassessment
uses only contemporaneously stored opening/current quotes and produces
PENDING_DATA/WATCH/CAUTION, never a trade instruction. Collection must supply
quotes separately. Older report versions remain accessible.

Follow-up v2 uses a contemporaneous quote captured within 15 minutes after
research during a session, or after the next opening. Reference choice and
benchmark mapping are frozen. Later historical imports cannot manufacture a
missing baseline. Horizons are the 1st, 5th and 20th later trading-day closes,
counting covered open dates, skipping holidays/weekends. Quotes must be captured
in the final 15 minutes and recorded/retrieved by five minutes after close.
Calendar gaps stay pending, absent observation windows become unavailable.
Benchmark comparisons require aligned quotes known by the horizon deadline.
These are raw provider-native changes; corporate actions, dividends, costs,
execution and causality remain unverified. **They are not investment returns.**

## Durable work and operations

PostgreSQL jobs use atomic SKIP LOCKED claims, expiring fenced leases, bounded
exponential retries and restart recovery. Signal and evidence-job creation is
atomic; source/snapshot uniqueness prevents duplicate persisted observations.
A job can retry provider calls: external exactly-once execution is not guaranteed.
Job controls use per-form deduplication keys. Cancellation is cooperative and
checked during lease renewal and provider/stage boundaries; already completed
calls/writes are retained. Deliberate retry preserves earlier failure metadata
and clears cancellation. Expired price slots cannot be replayed as current data.

Authenticated health routes: web `/api/health/live`, `/api/health/ready`; worker
`/health/live`, `/health/ready`, `/health/status`. `ops:readiness` sends configured
credentials and checks both services. Liveness/readiness is not live coverage.
Native backup/guarded restore tooling requires PostgreSQL client binaries, private
storage and a separate empty restore target. See the operations documents.
Never use `prisma db push`, edit applied migrations or reset an existing database.
Legacy Telegram-related schema records remain preserved but no delivery code runs.

## Commands and isolated checks

Frontend job controls expose the same worker operations as the CLI:

```sh
npm run announcements:check -- --file /path/to/saved-real-nse.xml
npm run announcements:fetch -- --file /path/to/saved-real-nse.xml
npm run announcements:match
npm run announcements:filter
npm run announcements:analyze -- --limit 5
npm run prices:import -- TCS --days 30
npm run prices:detect -- TCS
npm run movements:research -- SIGNAL_UUID --analyze
npm run briefings:morning -- --date YYYY-MM-DD
npm run briefings:closing -- --date YYYY-MM-DD
npm run briefings:reassess
npm run research:followups
npm run jobs:status
```

Without `--file`, announcement check/fetch uses live NSE. Do not import synthetic
fixtures into your research DB. Network scripts use Node's `--use-env-proxy`;
configure proxy CA trust/network access externally without disabling TLS checks.

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use mocked providers and an isolated in-memory PGlite database, applying
migrations only there. They need no Docker, real database, paid key or provider
access. A build does not connect to PostgreSQL. Live feeds, prices, Gemini,
calendar accuracy, real migrations, sustained runtime behavior, deployments and
backup/restore drills still require your separate operational validation.
