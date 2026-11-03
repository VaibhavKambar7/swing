CREATE TABLE "daily_briefings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "session_date" date NOT NULL,
  "report_version" text NOT NULL,
  "cutoff_at" timestamptz(6) NOT NULL,
  "window_start" timestamptz(6) NOT NULL,
  "generated_at" timestamptz(6) NOT NULL DEFAULT now(),
  "content" jsonb NOT NULL,
  "markdown" text NOT NULL,
  CONSTRAINT "daily_briefings_window_valid" CHECK ("window_start" < "cutoff_at" AND "generated_at" >= "cutoff_at")
);
CREATE UNIQUE INDEX "daily_briefings_session_unique" ON "daily_briefings"("kind", "session_date", "report_version");
CREATE INDEX "daily_briefings_cutoff_idx" ON "daily_briefings"("cutoff_at");
