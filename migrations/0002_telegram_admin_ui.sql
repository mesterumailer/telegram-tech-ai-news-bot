CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (setting_key, setting_value, updated_at)
VALUES ('publication_mode', 'manual', CURRENT_TIMESTAMP)
ON CONFLICT(setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS story_review_queue (
  story_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  story_json TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'publishing', 'published', 'rejected')),
  origin TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_story_review_queue_batch_status
ON story_review_queue(batch_id, review_status);
