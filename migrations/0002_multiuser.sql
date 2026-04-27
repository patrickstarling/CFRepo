-- Migration 0002 — multi-user support.
-- Adds user_email to articles, backfills existing rows with a placeholder
-- (you'll need to update those rows manually if you want them attributed),
-- and indexes user_email + (user_email, played_at) for fast per-user queries.

ALTER TABLE articles ADD COLUMN user_email TEXT NOT NULL DEFAULT 'unknown@local';

CREATE INDEX IF NOT EXISTS idx_articles_user            ON articles(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_user_unplayed   ON articles(user_email, played_at) WHERE played_at IS NULL;
