CREATE TABLE IF NOT EXISTS news_feed_items (
  source_url TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  candidate_image_url TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_news_feed_items_published_at
ON news_feed_items(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_feed_items_feed_id_published_at
ON news_feed_items(feed_id, published_at DESC);
