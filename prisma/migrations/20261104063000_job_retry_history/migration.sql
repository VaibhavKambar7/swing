CREATE TABLE "job_retry_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "job_id" UUID NOT NULL,
  "owner_key" TEXT NOT NULL, "previous_attempts" INTEGER NOT NULL,
  "previous_limit" INTEGER NOT NULL, "previous_error" TEXT,
  "previous_finished_at" TIMESTAMPTZ(6) NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reason" VARCHAR(500),
  CONSTRAINT "job_retry_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "job_retry_attempt_bounds" CHECK (previous_attempts >= 0 AND previous_attempts <= previous_limit AND previous_limit BETWEEN 1 AND 20),
  CONSTRAINT "job_retry_job_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "job_retry_requested_idx" ON "job_retry_requests"("job_id", "requested_at");
