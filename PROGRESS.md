# Swing implementation progress

Updated: 2 November 2026 (IST).

## Current status

Announcement ingestion is implemented and locally validated. Live NSE ingestion
is blocked by cloud network access. No live announcements have been ingested.
Next: validate the live feed, then match announcements to stocks and filter noise.

Delivery preference: website alerts first; email is optional later. Telegram is
deferred. Implement one subpart at a time and get a useful version running before
adding advanced features. Push completed changes directly to `main`.

## Checklist

### Part 1 — Foundation
- [x] 1.1 Install dependencies and generate Prisma Client.
- [x] 1.2 Apply database migrations and verify Prisma connectivity.
- [x] 1.3 Implement web and worker health endpoints.
- [ ] Verify web and worker startup together with database-backed HTTP readiness.

### Part 2 — Delivery (deferred until the research pipeline works)
- [ ] Design website alert inbox.
- [ ] Implement website alerts and read/unread state.
- [ ] Add email delivery if needed.

### Part 3 — Announcement ingestion (current)
- [x] 3.1 Implement an NSE RSS fetch adapter and parser.
- [x] 3.2 Store unmatched items in a database inbox.
- [x] 3.3 Prevent duplicates, including overlapping ingestion runs.
- [x] Add manual command: `npm run announcements:fetch`.
- [ ] Validate live NSE feed access and current feed format.
- [ ] Confirm a real announcement is stored through the manual command.

### Part 4 — Research pipeline
- [ ] 4.1 Define a small initial stock universe.
- [ ] 4.2 Match announcements to stocks; retain unmatched items.
- [ ] 4.3 Filter obvious announcement noise.
- [ ] 4.4 Add one AI provider for evidence-based summaries and risks.
- [ ] 4.5 Persist INVESTIGATE / WATCH / IGNORE assessments.

### Part 5 — Automatic monitoring
- [ ] 5.1 Database job runner, retries, and interrupted-job recovery.
- [ ] 5.2 Indian trading calendar and Asia/Kolkata scheduling.
- [ ] 5.3 Five-minute session checks; hourly news checks outside sessions.
- [ ] 5.4 Resume after restarts without duplicate processing.

### Part 6 — Free price monitoring
- [ ] 6.1 Verify a free provider's access, coverage, and timestamps.
- [ ] 6.2 Add a replaceable quotes/candles provider interface.
- [ ] 6.3 Store observations and data freshness.
- [ ] 6.4 Add basic movement detection.
- [ ] 6.5 Link movements to announcement/news evidence.

### Part 7 — Daily briefings
- [ ] 7.1 Morning briefing at 08:45 IST on trading days.
- [ ] 7.2 Market summary at 15:45 IST; mark incomplete data.
- [ ] 7.3 Persist reports and prevent duplicate delivery.
- [ ] 7.4 Reassess overnight candidates around 09:20 with fresh prices.

### Part 8 — Everyday use
- [ ] 8.1 Dashboard for announcements, research, alerts, and health.
- [ ] 8.2 Watchlist and notification preferences.
- [ ] 8.3 Useful / not useful feedback.
- [ ] 8.4 Deployment and database backups.
- [ ] 8.5 Improve reliability based on observed failures.

## Validation and blockers

- Passed: 36 tests across 3 test files, lint, TypeScript checks, both SQL
  migrations, and a real PostgreSQL query through Prisma.
- Live `announcements:fetch`: failed at fetch; the cloud proxy denied the NSE
  destination. The `nsearchives.nseindia.com` network addition was saved as a
  draft, but live access has not been validated after applying it.
- Production build and combined web/worker HTTP readiness: not yet verified.
- Google Docs MCP is unavailable in this session. This file is the persistent
  progress record until a writable Docs connector is available.

## Recent changes

- Implemented manual announcement RSS ingestion and the deduplicated feed inbox.
- Applied the initial schema and feed inbox migrations to the development DB.
- Added this checklist and repository instructions for ongoing progress updates.
