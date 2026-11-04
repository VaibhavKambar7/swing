CREATE TABLE "research_followups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "feed_research_id" UUID, "analysis_id" UUID,
  "horizon_sessions" INTEGER NOT NULL, "methodology_version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "reason" TEXT NOT NULL DEFAULT 'AWAITING_REFERENCE',
  "reference_snapshot_id" UUID, "observed_snapshot_id" UUID,
  "due_at" TIMESTAMPTZ(6), "reference_at" TIMESTAMPTZ(6), "observed_at" TIMESTAMPTZ(6),
  "reference_price" NUMERIC(38,18), "observed_price" NUMERIC(38,18), "change_pct" NUMERIC(18,8),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_followups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "followup_one_target" CHECK (num_nonnulls(feed_research_id, analysis_id) = 1),
  CONSTRAINT "followup_horizon" CHECK (horizon_sessions IN (1,5,20)),
  CONSTRAINT "followup_status" CHECK (status IN ('pending','measured','unavailable')),
  CONSTRAINT "followup_reference" CHECK ((reference_snapshot_id IS NULL AND reference_at IS NULL AND reference_price IS NULL) OR (reference_snapshot_id IS NOT NULL AND reference_at IS NOT NULL AND reference_price IS NOT NULL AND reference_price > 0)),
  CONSTRAINT "followup_measurement" CHECK ((status = 'measured' AND observed_snapshot_id IS NOT NULL AND reference_snapshot_id IS NOT NULL AND observed_at IS NOT NULL AND due_at IS NOT NULL AND observed_price IS NOT NULL AND observed_price > 0 AND change_pct IS NOT NULL AND observed_at > reference_at) OR (status <> 'measured' AND observed_snapshot_id IS NULL AND observed_at IS NULL AND observed_price IS NULL AND change_pct IS NULL)),
  CONSTRAINT "followup_research_fk" FOREIGN KEY ("feed_research_id") REFERENCES "feed_research"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "followup_analysis_fk" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "followup_reference_fk" FOREIGN KEY ("reference_snapshot_id") REFERENCES "market_snapshots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "followup_observed_fk" FOREIGN KEY ("observed_snapshot_id") REFERENCES "market_snapshots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "followup_research_unique" ON "research_followups"("feed_research_id", "horizon_sessions", "methodology_version");
CREATE UNIQUE INDEX "followup_analysis_unique" ON "research_followups"("analysis_id", "horizon_sessions", "methodology_version");
CREATE INDEX "followup_pending_idx" ON "research_followups"("status", "updated_at");
