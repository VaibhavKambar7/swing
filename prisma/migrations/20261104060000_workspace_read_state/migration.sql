CREATE TABLE "read_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_key" TEXT NOT NULL,
  "feed_item_id" UUID,
  "signal_id" UUID,
  "daily_briefing_id" UUID,
  "content_version" TEXT NOT NULL,
  "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "read_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "read_states_one_target" CHECK (num_nonnulls(feed_item_id, signal_id, daily_briefing_id) = 1),
  CONSTRAINT "read_states_feed_fk" FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "read_states_signal_fk" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "read_states_briefing_fk" FOREIGN KEY ("daily_briefing_id") REFERENCES "daily_briefings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "read_states_feed_unique" ON "read_states"("owner_key", "feed_item_id");
CREATE UNIQUE INDEX "read_states_signal_unique" ON "read_states"("owner_key", "signal_id");
CREATE UNIQUE INDEX "read_states_briefing_unique" ON "read_states"("owner_key", "daily_briefing_id");
