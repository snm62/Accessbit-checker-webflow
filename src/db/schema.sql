

-- Entitlements (populated by billing webhooks — insert a free row at install)
CREATE TABLE IF NOT EXISTS entitlements (
  site_id        TEXT PRIMARY KEY,
  plan           TEXT    NOT NULL DEFAULT 'free',
  status         TEXT    NOT NULL DEFAULT 'active',  -- active | suspended | cancelled
  pages_per_scan INTEGER NOT NULL DEFAULT 50,
  pages_per_month INTEGER NOT NULL DEFAULT 200,
  period_start   TEXT,   -- ISO date
  period_end     TEXT,   -- ISO date
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Monthly usage counters (atomic quota enforcement)
CREATE TABLE IF NOT EXISTS usage (
  site_id         TEXT    NOT NULL,
  period          TEXT    NOT NULL,  -- YYYY-MM
  pages_reserved  INTEGER NOT NULL DEFAULT 0,
  pages_used      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, period)
);

-- Jobs
CREATE TABLE IF NOT EXISTS jobs (
  job_id         TEXT PRIMARY KEY,  -- random UUID
  site_id        TEXT NOT NULL,
  created_by     TEXT NOT NULL,     -- Webflow user ID
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|cancelled|failed
  total_pages    INTEGER NOT NULL DEFAULT 0,
  done_pages     INTEGER NOT NULL DEFAULT 0,
  failed_pages   INTEGER NOT NULL DEFAULT 0,
  skipped_pages  INTEGER NOT NULL DEFAULT 0,
  reserved_pages INTEGER NOT NULL DEFAULT 0,
  domain         TEXT,
  plan_at_create TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_site_status ON jobs (site_id, status);

-- One active job per site: prevent concurrent scans
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active
  ON jobs (site_id)
  WHERE status IN ('queued', 'running');

-- Job pages
CREATE TABLE IF NOT EXISTS job_pages (
  job_id      TEXT    NOT NULL,
  page_id     TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  title       TEXT,
  is_cms      INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,   -- compact summary stored inline
  r2_key      TEXT,    -- full result stored in R2
  error       TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_job_pages_job_status ON job_pages (job_id, status);
