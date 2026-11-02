CREATE TYPE "feed_relevance_status" AS ENUM ('pending', 'keep', 'routine', 'review');

ALTER TABLE "feed_items"
  ADD COLUMN "relevance_status" "feed_relevance_status" NOT NULL DEFAULT 'pending',
  ADD COLUMN "relevance_reason" text,
  ADD COLUMN "relevance_rule_version" text,
  ADD COLUMN "relevance_checked_at" timestamptz(6),
  ADD CONSTRAINT "feed_items_relevance_complete" CHECK (
    ("relevance_status" = 'pending' AND "relevance_reason" IS NULL AND "relevance_rule_version" IS NULL AND "relevance_checked_at" IS NULL)
    OR
    ("relevance_status" <> 'pending' AND "relevance_reason" IS NOT NULL AND "relevance_rule_version" IS NOT NULL AND "relevance_checked_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "feed_items_relevance_requires_match" CHECK (
    "relevance_status" = 'pending' OR "match_status" = 'matched'
  );

CREATE INDEX "feed_items_relevance_idx" ON "feed_items" ("match_status", "relevance_status", "id");
