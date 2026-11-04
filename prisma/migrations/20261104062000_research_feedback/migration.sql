CREATE TABLE "research_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "owner_key" TEXT NOT NULL,
  "feed_item_id" UUID, "signal_id" UUID, "daily_briefing_id" UUID,
  "content_version" TEXT NOT NULL, "useful" BOOLEAN NOT NULL, "reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_feedback_one_target" CHECK (num_nonnulls(feed_item_id, signal_id, daily_briefing_id) = 1),
  CONSTRAINT "research_feedback_feed_fk" FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "research_feedback_signal_fk" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "research_feedback_briefing_fk" FOREIGN KEY ("daily_briefing_id") REFERENCES "daily_briefings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "research_feedback_feed_unique" ON "research_feedback"("owner_key", "feed_item_id", "content_version");
CREATE UNIQUE INDEX "research_feedback_signal_unique" ON "research_feedback"("owner_key", "signal_id", "content_version");
CREATE UNIQUE INDEX "research_feedback_briefing_unique" ON "research_feedback"("owner_key", "daily_briefing_id", "content_version");
CREATE INDEX "research_feedback_updated_idx" ON "research_feedback"("owner_key", "updated_at");
