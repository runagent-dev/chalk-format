-- Reference database for a Chalk asset registry (spec/1.2/registry-api.md). PostgreSQL 14+.
-- Informative: any database that serves the registry API is fine. Students' devices never query it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- text search in any script (no Bengali stemmer exists)

-- What search matches: title, file name and tags in one string. A generated column needs an IMMUTABLE
-- expression, and array_to_string is only STABLE, so it is wrapped (joining text is deterministic).
CREATE FUNCTION chalk_search_text(title text, filename text, tags text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT coalesce(title, '') || ' ' || coalesce(filename, '') || ' ' || coalesce(array_to_string(tags, ' '), '') $$;

-- The stores the registry writes to and hands to readers (spec 1.2 §5.1).
CREATE TABLE stores (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('derived', 'indexed', 'api')),
  template     text,                          -- derived: e.g. https://media.example.org/c1/{h0}/{h1}/{h}
  base         text,                          -- indexed / api
  media        text[] NOT NULL DEFAULT '{*/*}',
  priority     integer NOT NULL DEFAULT 100,
  verify       text NOT NULL DEFAULT 'first' CHECK (verify IN ('always', 'first', 'none')),
  auth         text NOT NULL DEFAULT 'none' CHECK (auth IN ('none', 'bearer')),
  bucket       text,                          -- where uploads go (not published to readers)
  public       boolean NOT NULL DEFAULT true, -- listed by GET v1/stores
  CHECK ((kind = 'derived') = (template IS NOT NULL))
);

-- One row per asset: the key is the primary key, so lookups are an index probe.
CREATE TABLE assets (
  key          text PRIMARY KEY CHECK (key ~ '^c1:[a-z2-7]{25}[aeimquy4]$'),
  sha256       char(64) NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  type         text NOT NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  width        integer,
  height       integer,
  duration     real,
  pages        integer,
  title        text,
  filename     text,
  tags         text[] NOT NULL DEFAULT '{}',
  subject      text,
  license      text,
  poster       text REFERENCES assets(key),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'withdrawn')),
  withdrawn_reason text,
  pinned       boolean NOT NULL DEFAULT false,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search_text  text GENERATED ALWAYS AS (chalk_search_text(title, filename, tags)) STORED
);
CREATE INDEX assets_search_trgm ON assets USING gin (search_text gin_trgm_ops);
CREATE INDEX assets_type ON assets (type);
CREATE INDEX assets_subject ON assets (subject);
CREATE INDEX assets_tags ON assets USING gin (tags);
CREATE INDEX assets_uploader ON assets (uploaded_by, created_at DESC);

-- Other versions of the same media item (spec 1.2 §4.3).
CREATE TABLE renditions (
  primary_key  text NOT NULL REFERENCES assets(key) ON DELETE CASCADE,
  rendition    text NOT NULL REFERENCES assets(key) ON DELETE CASCADE,
  PRIMARY KEY (primary_key, rendition)
);

-- Where each store keeps each asset; one asset can live in several stores.
CREATE TABLE locations (
  key          text NOT NULL REFERENCES assets(key) ON DELETE CASCADE,
  store        text NOT NULL REFERENCES stores(id),
  path         text NOT NULL,
  verified_at  timestamptz,
  PRIMARY KEY (key, store)
);

-- Which books use which assets (registry-api §6): "where is this used?", and safe clean-up.
CREATE TABLE book_assets (
  book_id      text NOT NULL,
  key          text NOT NULL REFERENCES assets(key),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, key)
);
CREATE INDEX book_assets_key ON book_assets (key);

-- Search example: GET v1/search?q=দোলক&type=video/*
-- Word similarity (<%) compares the query with the best-matching part of the text, so a short query still finds
-- a long title; plain similarity (%) would compare it with the whole string.
--   SELECT * FROM assets
--   WHERE status = 'available' AND type LIKE 'video/%' AND 'দোলক' <% search_text
--   ORDER BY word_similarity('দোলক', search_text) DESC, created_at DESC LIMIT 30;
