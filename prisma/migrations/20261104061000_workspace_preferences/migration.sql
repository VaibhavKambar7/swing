CREATE TABLE "watchlist_entries" (
  "owner_key" TEXT NOT NULL,
  "instrument_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "watchlist_entries_pkey" PRIMARY KEY ("owner_key", "instrument_id"),
  CONSTRAINT "watchlist_instrument_fk" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "watchlist_instrument_idx" ON "watchlist_entries"("instrument_id");
CREATE TABLE "workspace_preferences" (
  "owner_key" TEXT NOT NULL,
  "announcements_enabled" BOOLEAN NOT NULL DEFAULT true,
  "movements_enabled" BOOLEAN NOT NULL DEFAULT true,
  "briefings_enabled" BOOLEAN NOT NULL DEFAULT true,
  "investigate_enabled" BOOLEAN NOT NULL DEFAULT true,
  "watch_enabled" BOOLEAN NOT NULL DEFAULT true,
  "unassessed_enabled" BOOLEAN NOT NULL DEFAULT false,
  "watchlist_only" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_preferences_pkey" PRIMARY KEY ("owner_key")
);
