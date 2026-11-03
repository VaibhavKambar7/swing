-- Widen existing exact signal prices to match stored observations; no data reset.
ALTER TABLE "signals"
  ALTER COLUMN "price" TYPE numeric(38,18),
  ALTER COLUMN "reference_price" TYPE numeric(38,18);
