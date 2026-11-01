CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('processing', 'processed', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_webhook_updates_created_at
ON telegram_webhook_updates(created_at);

CREATE TABLE IF NOT EXISTS telegram_latest_view_locks (
  chat_id TEXT PRIMARY KEY,
  lock_update_id INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
