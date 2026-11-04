ALTER TABLE research_followups ADD COLUMN comparison jsonb;
ALTER TABLE jobs ADD COLUMN cancel_requested_at timestamptz;
