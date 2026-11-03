ALTER TABLE "analyses" ADD COLUMN "input_hash" text, ADD COLUMN "input_snapshot" jsonb;
CREATE UNIQUE INDEX "analyses_input_unique" ON "analyses" ("signal_id", "provider", "model", "prompt_version", "input_hash");
