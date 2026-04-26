-- Articles table — one row per saved item, regardless of source.
CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,            -- uuid
  source_type   TEXT NOT NULL,               -- 'url' | 'pdf'
  source_ref    TEXT NOT NULL,               -- the URL, or the R2 key of the uploaded PDF
  title         TEXT,                        -- filled in after processing
  summary       TEXT,                        -- 2-3 sentence summary from the LLM
  text_key      TEXT,                        -- R2 key in ARTICLES bucket holding the full extracted text
  audio_key     TEXT,                        -- R2 key in ARTICLES bucket holding the MP3
  audio_seconds INTEGER,                     -- approximate duration, for the digest UI
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'done' | 'failed'
  error         TEXT,                        -- last error message if status=failed
  played_at     INTEGER,                     -- unix seconds; null = unplayed
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_unplayed   ON articles(played_at) WHERE played_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at DESC);
