CREATE TABLE feed_sources (id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('nse','bse','news-search')), query text, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (kind <> 'news-search' OR length(query) BETWEEN 3 AND 300));
INSERT INTO feed_sources(id,name,kind,enabled) VALUES ('nse','NSE announcements','nse',true), ('bse','BSE announcements','bse',false);
ALTER TABLE feed_items ADD COLUMN issuer_code text;
