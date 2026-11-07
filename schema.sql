CREATE TABLE IF NOT EXISTS mqtt_probe_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_limits (
  bucket INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO probe_lock (id, expires_at) VALUES (1, 0);
