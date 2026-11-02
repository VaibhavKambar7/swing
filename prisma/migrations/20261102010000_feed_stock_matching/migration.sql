CREATE TYPE "feed_match_status" AS ENUM ('pending', 'matched', 'unmatched', 'ambiguous');

ALTER TABLE "feed_items"
  ADD COLUMN "match_status" "feed_match_status" NOT NULL DEFAULT 'pending',
  ADD COLUMN "match_checked_at" timestamptz(6),
  ADD COLUMN "instrument_id" uuid,
  ADD CONSTRAINT "feed_items_instrument_fk" FOREIGN KEY ("instrument_id")
    REFERENCES "instruments" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "feed_items_match_consistent" CHECK (
    ("match_status" = 'matched') = ("instrument_id" IS NOT NULL)
  );

CREATE INDEX "feed_items_instrument_idx" ON "feed_items" ("instrument_id");
