CREATE TABLE "market_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instrument_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_symbol" text NOT NULL,
  "content_hash" text NOT NULL,
  "retrieved_at" timestamptz(6) NOT NULL,
  "requested_days" integer NOT NULL,
  "skipped_bars" integer NOT NULL,
  "quote_price" numeric(38,18),
  "quote_time" timestamptz(6),
  "quote_age_seconds" numeric(20,3),
  "quote_freshness" text,
  "quote_delay_status" text,
  "currency" text NOT NULL DEFAULT 'INR',
  "recorded_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "market_snapshots_instrument_fk" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "market_snapshot_bounds" CHECK ("requested_days" BETWEEN 1 AND 365 AND "skipped_bars" >= 0 AND "currency" = 'INR'),
  CONSTRAINT "market_snapshot_quote_complete" CHECK (
    ("quote_price" IS NULL AND "quote_time" IS NULL AND "quote_age_seconds" IS NULL AND "quote_freshness" IS NULL AND "quote_delay_status" IS NULL)
    OR ("quote_price" IS NOT NULL AND "quote_price" > 0 AND "quote_price" <> 'NaN'::numeric AND "quote_time" IS NOT NULL AND "quote_age_seconds" IS NOT NULL
        AND "quote_age_seconds" = EXTRACT(epoch FROM ("retrieved_at" - "quote_time")) AND "quote_age_seconds" >= -60
        AND "quote_freshness" IS NOT NULL AND "quote_freshness" IN ('recent', 'stale', 'clock_skew')
        AND "quote_freshness" = CASE WHEN "quote_age_seconds" < 0 THEN 'clock_skew' WHEN "quote_age_seconds" > 300 THEN 'stale' ELSE 'recent' END
        AND "quote_delay_status" IS NOT NULL AND "quote_delay_status" = 'unknown')
  )
);
CREATE UNIQUE INDEX "market_snapshots_content_unique" ON "market_snapshots"("instrument_id", "provider", "content_hash");
CREATE INDEX "market_snapshots_observed_idx" ON "market_snapshots"("instrument_id", "provider", "retrieved_at");

CREATE TABLE "market_candles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" uuid NOT NULL,
  "session_date" date NOT NULL,
  "source_time" timestamptz(6) NOT NULL,
  "open" numeric(38,18) NOT NULL,
  "high" numeric(38,18) NOT NULL,
  "low" numeric(38,18) NOT NULL,
  "close" numeric(38,18) NOT NULL,
  "volume" bigint,
  "adjusted_close" numeric(38,18),
  "price_basis" text NOT NULL,
  "completion" text NOT NULL,
  CONSTRAINT "market_candles_snapshot_fk" FOREIGN KEY ("snapshot_id") REFERENCES "market_snapshots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "market_candle_prices_valid" CHECK ("open" > 0 AND "low" > 0 AND "close" > 0 AND "low" <= LEAST("open", "close") AND "high" >= GREATEST("open", "close") AND "high" >= "low" AND ("adjusted_close" IS NULL OR "adjusted_close" > 0)),
  CONSTRAINT "market_candle_metadata_valid" CHECK (("volume" IS NULL OR "volume" >= 0) AND "price_basis" = 'provider_native_unverified' AND "completion" = 'unknown'),
  CONSTRAINT "market_candle_finite" CHECK ("open" <> 'NaN'::numeric AND "high" <> 'NaN'::numeric AND "low" <> 'NaN'::numeric AND "close" <> 'NaN'::numeric AND ("adjusted_close" IS NULL OR "adjusted_close" <> 'NaN'::numeric))
);
CREATE UNIQUE INDEX "market_candles_snapshot_session_unique" ON "market_candles"("snapshot_id", "session_date");
CREATE INDEX "market_candles_session_idx" ON "market_candles"("session_date");
