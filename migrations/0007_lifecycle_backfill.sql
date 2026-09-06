CREATE TABLE IF NOT EXISTS lifecycle_maintenance_runs (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
