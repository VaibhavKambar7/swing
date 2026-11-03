CREATE TABLE "post_open_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_date" date NOT NULL,
  "morning_briefing_id" uuid NOT NULL,
  "instrument_id" uuid NOT NULL,
  "rules_version" text NOT NULL,
  "input_hash" text NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "assessed_at" timestamptz(6) NOT NULL,
  "content" jsonb NOT NULL,
  CONSTRAINT "post_open_morning_fk" FOREIGN KEY ("morning_briefing_id") REFERENCES "daily_briefings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "post_open_instrument_fk" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "post_open_status_valid" CHECK ("status" IN ('PENDING_DATA', 'WATCH', 'CAUTION'))
);
CREATE UNIQUE INDEX "post_open_input_unique" ON "post_open_assessments"("morning_briefing_id", "instrument_id", "rules_version", "input_hash");
CREATE INDEX "post_open_assessed_idx" ON "post_open_assessments"("session_date", "instrument_id", "assessed_at");
