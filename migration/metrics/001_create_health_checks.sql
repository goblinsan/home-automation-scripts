-- Health check time-series storage
CREATE TABLE IF NOT EXISTS health_checks (
  id               BIGSERIAL PRIMARY KEY,
  target_kind      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  status           TEXT NOT NULL,
  response_time_ms INTEGER,
  details          JSONB,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_target_time
  ON health_checks (target_kind, target_id, checked_at DESC);
