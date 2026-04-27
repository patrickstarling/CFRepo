-- Add columns for normalized URL and title matching, used by dedup.
ALTER TABLE articles ADD COLUMN normalized_ref   TEXT;
ALTER TABLE articles ADD COLUMN normalized_title TEXT;

-- Backfill existing rows. We're casting source_ref as a stand-in here;
-- the proper normalization will happen on the next save. This is just enough
-- to enable the new indexes without nulls.
UPDATE articles SET normalized_ref   = source_ref WHERE normalized_ref   IS NULL;
UPDATE articles SET normalized_title = LOWER(title) WHERE normalized_title IS NULL AND title IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_articles_normalized_ref   ON articles(user_email, source_type, normalized_ref);
CREATE INDEX IF NOT EXISTS idx_articles_normalized_title ON articles(user_email, normalized_title);