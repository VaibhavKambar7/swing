CREATE TABLE "feed_research" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "feed_item_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "input_hash" text NOT NULL,
  "input_snapshot" jsonb NOT NULL,
  "classification" "classification" NOT NULL,
  "summary" text NOT NULL,
  "significance" text NOT NULL,
  "risks" jsonb NOT NULL,
  "uncertainties" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "feed_research_item_fk" FOREIGN KEY ("feed_item_id")
    REFERENCES "feed_items" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "feed_research_tokens_valid" CHECK (
    ("input_tokens" IS NULL OR "input_tokens" >= 0) AND
    ("output_tokens" IS NULL OR "output_tokens" >= 0)
  )
);
CREATE UNIQUE INDEX "feed_research_input_unique" ON "feed_research"
  ("feed_item_id", "provider", "model", "prompt_version", "input_hash");
CREATE INDEX "feed_research_created_idx" ON "feed_research" ("created_at");
