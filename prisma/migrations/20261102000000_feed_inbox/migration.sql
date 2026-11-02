CREATE TABLE "feed_items" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "source" text NOT NULL,
    "source_id" text NOT NULL,
    "title" text NOT NULL,
    "url" text NOT NULL,
    "description" text,
    "published_at" timestamptz(6),
    "discovered_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "feed_items_source_unique" ON "feed_items" ("source", "source_id");
CREATE INDEX "feed_items_discovered_idx" ON "feed_items" ("discovered_at");
