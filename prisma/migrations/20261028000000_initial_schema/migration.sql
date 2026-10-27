-- Initial schema, including custom CHECK constraints.
CREATE TYPE "public"."classification" AS ENUM('INVESTIGATE', 'WATCH', 'IGNORE');

CREATE TYPE "public"."delivery_status" AS ENUM('sending', 'sent', 'failed', 'unknown');

CREATE TYPE "public"."evidence_kind" AS ENUM('official_announcement', 'news');

CREATE TYPE "public"."instrument_kind" AS ENUM('equity', 'index');

CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'retry', 'succeeded', 'failed');

CREATE TYPE "public"."outcome_status" AS ENUM('pending', 'completed', 'unavailable');

CREATE TYPE "public"."price_basis" AS ENUM('unadjusted', 'adjusted');

CREATE TYPE "public"."signal_origin" AS ENUM('movement', 'announcement');

CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"analysis_id" uuid,
	"dedupe_key" text NOT NULL,
	"classification" "classification" NOT NULL,
	"rules_version" text NOT NULL,
	"reason" text NOT NULL,
	"message" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"first_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_dedupe_key_unique" UNIQUE("dedupe_key")
);


CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"summary" text NOT NULL,
	"catalyst" text,
	"catalyst_verified" boolean DEFAULT false NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uncertainties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_inr" numeric(14, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_id_signal_unique" UNIQUE("id","signal_id"),
	CONSTRAINT "analyses_nonnegative_usage" CHECK (("analyses"."input_tokens" IS NULL OR "analyses"."input_tokens" >= 0) AND ("analyses"."output_tokens" IS NULL OR "analyses"."output_tokens" >= 0) AND ("analyses"."cost_inr" IS NULL OR "analyses"."cost_inr" >= 0)),
	CONSTRAINT "analyses_array_fields" CHECK (jsonb_typeof("analyses"."risks") = 'array' AND jsonb_typeof("analyses"."uncertainties") = 'array')
);


CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"category" text,
	"published_at" timestamp with time zone NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_source_unique" UNIQUE("source","source_id","instrument_id"),
	CONSTRAINT "announcements_id_instrument_unique" UNIQUE("id","instrument_id")
);


CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "delivery_status" DEFAULT 'sending' NOT NULL,
	"telegram_message_id" text,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "delivery_attempts_alert_attempt_unique" UNIQUE("alert_id","attempt"),
	CONSTRAINT "delivery_attempts_positive_attempt" CHECK ("delivery_attempts"."attempt" > 0),
	CONSTRAINT "delivery_attempts_status_fields" CHECK (("delivery_attempts"."status" = 'sending' AND "delivery_attempts"."finished_at" IS NULL) OR ("delivery_attempts"."status" <> 'sending' AND "delivery_attempts"."finished_at" IS NOT NULL)),
	CONSTRAINT "delivery_attempts_sent_message" CHECK ("delivery_attempts"."status" <> 'sent' OR "delivery_attempts"."telegram_message_id" IS NOT NULL),
	CONSTRAINT "delivery_attempts_time_order" CHECK ("delivery_attempts"."finished_at" >= "delivery_attempts"."started_at")
);


CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"useful" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_alert_user_unique" UNIQUE("alert_id","telegram_user_id")
);


CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"kind" "instrument_kind" DEFAULT 'equity' NOT NULL,
	"isin" text,
	"kite_token" bigint,
	"sector" text,
	"benchmark_id" uuid,
	"sector_index_id" uuid,
	"in_universe" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_exchange_symbol_unique" UNIQUE("exchange","symbol"),
	CONSTRAINT "instruments_kite_token_unique" UNIQUE("kite_token"),
	CONSTRAINT "instruments_token_positive" CHECK ("instruments"."kite_token" > 0),
	CONSTRAINT "instruments_no_self_context" CHECK (("instruments"."benchmark_id" IS NULL OR "instruments"."benchmark_id" <> "instruments"."id") AND ("instruments"."sector_index_id" IS NULL OR "instruments"."sector_index_id" <> "instruments"."id"))
);


CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"signal_id" uuid,
	"alert_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "jobs_attempts_bounds" CHECK ("jobs"."max_attempts" > 0 AND "jobs"."attempts" >= 0 AND "jobs"."attempts" <= "jobs"."max_attempts"),
	CONSTRAINT "jobs_lease_fields" CHECK (("jobs"."status" = 'running' AND "jobs"."locked_by" IS NOT NULL AND "jobs"."locked_until" IS NOT NULL) OR ("jobs"."status" <> 'running' AND "jobs"."locked_by" IS NULL AND "jobs"."locked_until" IS NULL)),
	CONSTRAINT "jobs_completion_fields" CHECK (("jobs"."status" IN ('succeeded', 'failed') AND "jobs"."completed_at" IS NOT NULL) OR ("jobs"."status" NOT IN ('succeeded', 'failed') AND "jobs"."completed_at" IS NULL))
);


CREATE TABLE "performance_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"horizon_trading_days" integer NOT NULL,
	"status" "outcome_status" DEFAULT 'pending' NOT NULL,
	"reference_session" date,
	"due_session" date,
	"reference_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"reference_price" numeric(20, 6),
	"observed_price" numeric(20, 6),
	"benchmark_id" uuid,
	"benchmark_reference_price" numeric(20, 6),
	"benchmark_observed_price" numeric(20, 6),
	"stock_return_pct" numeric(18, 8),
	"benchmark_return_pct" numeric(18, 8),
	"excess_return_pct" numeric(18, 8),
	"price_basis" "price_basis" DEFAULT 'unadjusted' NOT NULL,
	"methodology_version" text NOT NULL,
	"unavailable_reason" text,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performance_outcomes_alert_horizon_unique" UNIQUE("alert_id","horizon_trading_days"),
	CONSTRAINT "performance_outcomes_horizon_check" CHECK ("performance_outcomes"."horizon_trading_days" IN (1, 5, 15)),
	CONSTRAINT "performance_outcomes_positive_prices" CHECK (("performance_outcomes"."reference_price" IS NULL OR "performance_outcomes"."reference_price" > 0) AND ("performance_outcomes"."observed_price" IS NULL OR "performance_outcomes"."observed_price" > 0) AND ("performance_outcomes"."benchmark_reference_price" IS NULL OR "performance_outcomes"."benchmark_reference_price" > 0) AND ("performance_outcomes"."benchmark_observed_price" IS NULL OR "performance_outcomes"."benchmark_observed_price" > 0)),
	CONSTRAINT "performance_outcomes_time_order" CHECK ("performance_outcomes"."observed_at" >= "performance_outcomes"."reference_at"),
	CONSTRAINT "performance_outcomes_session_order" CHECK ("performance_outcomes"."due_session" >= "performance_outcomes"."reference_session"),
	CONSTRAINT "performance_outcomes_completed_fields" CHECK ("performance_outcomes"."status" <> 'completed' OR ("performance_outcomes"."reference_price" IS NOT NULL AND "performance_outcomes"."observed_price" IS NOT NULL AND "performance_outcomes"."reference_at" IS NOT NULL AND "performance_outcomes"."observed_at" IS NOT NULL AND "performance_outcomes"."stock_return_pct" IS NOT NULL AND "performance_outcomes"."measured_at" IS NOT NULL AND "performance_outcomes"."due_session" IS NOT NULL AND "performance_outcomes"."reference_session" IS NOT NULL)),
	CONSTRAINT "performance_outcomes_unavailable_reason" CHECK ("performance_outcomes"."status" <> 'unavailable' OR "performance_outcomes"."unavailable_reason" IS NOT NULL),
	CONSTRAINT "performance_outcomes_benchmark_fields" CHECK (("performance_outcomes"."benchmark_return_pct" IS NULL AND "performance_outcomes"."excess_return_pct" IS NULL) OR ("performance_outcomes"."benchmark_return_pct" IS NOT NULL AND "performance_outcomes"."excess_return_pct" IS NOT NULL AND "performance_outcomes"."stock_return_pct" IS NOT NULL AND "performance_outcomes"."benchmark_id" IS NOT NULL AND "performance_outcomes"."benchmark_reference_price" IS NOT NULL AND "performance_outcomes"."benchmark_observed_price" IS NOT NULL))
);


CREATE TABLE "polling_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_published_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polling_checkpoints_source_scope_unique" UNIQUE("source","scope")
);


CREATE TABLE "signal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"excerpt" text,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text,
	CONSTRAINT "signal_evidence_signal_url_unique" UNIQUE("signal_id","url")
);


CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"origin" "signal_origin" NOT NULL,
	"announcement_id" uuid,
	"dedupe_key" text NOT NULL,
	"detector_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone,
	"price" numeric(20, 6),
	"reference_price" numeric(20, 6),
	"price_change_pct" numeric(18, 8),
	"relative_volume" numeric(18, 6),
	"benchmark_return_pct" numeric(18, 8),
	"sector_return_pct" numeric(18, 8),
	"volatility_score" numeric(18, 8),
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "signals_origin_source_check" CHECK (("signals"."origin" = 'movement' AND "signals"."announcement_id" IS NULL AND "signals"."price" IS NOT NULL AND "signals"."reference_price" IS NOT NULL AND "signals"."price_change_pct" IS NOT NULL AND "signals"."window_start" IS NOT NULL) OR ("signals"."origin" = 'announcement' AND "signals"."announcement_id" IS NOT NULL)),
	CONSTRAINT "signals_positive_prices" CHECK (("signals"."price" IS NULL OR "signals"."price" > 0) AND ("signals"."reference_price" IS NULL OR "signals"."reference_price" > 0)),
	CONSTRAINT "signals_relative_volume_nonnegative" CHECK ("signals"."relative_volume" >= 0),
	CONSTRAINT "signals_window_order" CHECK ("signals"."window_start" <= "signals"."observed_at")
);


ALTER TABLE "alerts" ADD CONSTRAINT "alerts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "alerts" ADD CONSTRAINT "alerts_analysis_signal_fk" FOREIGN KEY ("analysis_id","signal_id") REFERENCES "public"."analyses"("id","signal_id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "analyses" ADD CONSTRAINT "analyses_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "feedback" ADD CONSTRAINT "feedback_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "instruments" ADD CONSTRAINT "instruments_benchmark_id_instruments_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "instruments" ADD CONSTRAINT "instruments_sector_index_id_instruments_id_fk" FOREIGN KEY ("sector_index_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "performance_outcomes" ADD CONSTRAINT "performance_outcomes_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "performance_outcomes" ADD CONSTRAINT "performance_outcomes_benchmark_id_instruments_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "signals" ADD CONSTRAINT "signals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "signals" ADD CONSTRAINT "signals_announcement_instrument_fk" FOREIGN KEY ("announcement_id","instrument_id") REFERENCES "public"."announcements"("id","instrument_id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "alerts_signal_idx" ON "alerts" USING btree ("signal_id");

CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");

CREATE INDEX "analyses_signal_created_idx" ON "analyses" USING btree ("signal_id","created_at");

CREATE INDEX "announcements_instrument_published_idx" ON "announcements" USING btree ("instrument_id","published_at");

CREATE INDEX "instruments_universe_idx" ON "instruments" USING btree ("in_universe","active");

CREATE INDEX "jobs_runnable_idx" ON "jobs" USING btree ("status","run_after");

CREATE INDEX "jobs_lease_expiry_idx" ON "jobs" USING btree ("locked_until") WHERE "jobs"."status" = 'running';

CREATE INDEX "jobs_signal_idx" ON "jobs" USING btree ("signal_id");

CREATE INDEX "jobs_alert_idx" ON "jobs" USING btree ("alert_id");

CREATE INDEX "performance_outcomes_due_idx" ON "performance_outcomes" USING btree ("status","due_session");

CREATE INDEX "signals_instrument_observed_idx" ON "signals" USING btree ("instrument_id","observed_at");

CREATE INDEX "signals_announcement_idx" ON "signals" USING btree ("announcement_id");