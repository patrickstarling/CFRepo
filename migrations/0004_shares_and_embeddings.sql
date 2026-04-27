-- Share tokens (one row per shared article) and a column to indicate which
-- articles have already been embedded into Vectorize.
 
CREATE TABLE IF NOT EXISTS shares (
  token       TEXT PRIMARY KEY,           -- random URL-safe token
  article_id  TEXT NOT NULL,
  user_email  TEXT NOT NULL,              -- the person who shared (for revoke)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at  INTEGER,                    -- null = active, populated = revoked
  view_count  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
 
CREATE INDEX IF NOT EXISTS idx_shares_article ON shares(article_id);
CREATE INDEX IF NOT EXISTS idx_shares_user    ON shares(user_email, created_at DESC);
 
-- Track which articles have been embedded into Vectorize, so we don't
-- re-embed on every consumer run.
ALTER TABLE articles ADD COLUMN embedded_at INTEGER;