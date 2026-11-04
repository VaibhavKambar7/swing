ALTER TABLE instruments ADD COLUMN yahoo_symbol text, ADD COLUMN bse_code text;
CREATE TABLE universe_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL,
 effective_date date NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 members jsonb NOT NULL, content_hash text NOT NULL UNIQUE,
 CHECK (jsonb_typeof(members) = 'array')
);
