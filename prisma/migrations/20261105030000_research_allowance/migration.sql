CREATE TABLE "research_allowance_uses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "day" DATE NOT NULL,
  "provider" TEXT NOT NULL, "model" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "error_code" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "research_allowance_uses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_allowance_status" CHECK (status IN ('pending','success','failed')),
  CONSTRAINT "research_allowance_completion" CHECK ((status = 'pending' AND completed_at IS NULL) OR (status <> 'pending' AND completed_at IS NOT NULL))
);
CREATE INDEX "research_allowance_day_idx" ON "research_allowance_uses"("day", "status");
