-- Project tracking tables for assistant / coach summaries
CREATE TABLE IF NOT EXISTS tracked_projects (
  project_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'on-track',
  priority          TEXT NOT NULL DEFAULT 'medium',
  summary           TEXT NOT NULL DEFAULT '',
  next_action       TEXT NOT NULL DEFAULT '',
  notes_repo_path   TEXT,
  plan_file_path    TEXT,
  metadata          JSONB,
  last_check_in_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_milestones (
  id          BIGSERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES tracked_projects(project_id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  target_date DATE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, milestone_id)
);

CREATE TABLE IF NOT EXISTS project_updates (
  id          BIGSERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES tracked_projects(project_id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual',
  kind        TEXT NOT NULL DEFAULT 'status-update',
  summary     TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_tracking_updated
  ON tracked_projects (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project
  ON project_milestones (project_id, sort_order ASC, target_date ASC);

CREATE INDEX IF NOT EXISTS idx_project_updates_project_time
  ON project_updates (project_id, created_at DESC);
