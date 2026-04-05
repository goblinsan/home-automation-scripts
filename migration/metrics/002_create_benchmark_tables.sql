-- Benchmark runs and their individual results
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id          SERIAL PRIMARY KEY,
  suite_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  engine      TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  hardware    TEXT NOT NULL DEFAULT '',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS benchmark_results (
  id        SERIAL PRIMARY KEY,
  run_id    INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  test_name TEXT NOT NULL,
  metric    TEXT NOT NULL,
  value     DOUBLE PRECISION NOT NULL,
  unit      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_bench_suite
  ON benchmark_runs (suite_id, started_at DESC);
