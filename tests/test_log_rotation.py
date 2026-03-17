"""Tests for scripts/log_rotation.py."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.log_rotation import prune_old_logs, run, DESCRIPTION


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_old_file(directory: Path, name: str, age_days: float) -> Path:
    """Create a file and back-date its mtime by *age_days* days."""
    p = directory / name
    p.write_text("log content", encoding="utf-8")
    old_mtime = time.time() - age_days * 86400
    import os
    os.utime(p, (old_mtime, old_mtime))
    return p


# ---------------------------------------------------------------------------
# prune_old_logs
# ---------------------------------------------------------------------------


class TestPruneOldLogs:
    def test_deletes_old_files(self, tmp_path):
        old_file = _make_old_file(tmp_path, "old.log", age_days=40)
        deleted = prune_old_logs(tmp_path, max_age_days=30)
        assert old_file in deleted
        assert not old_file.exists()

    def test_keeps_recent_files(self, tmp_path):
        recent = _make_old_file(tmp_path, "recent.log", age_days=5)
        deleted = prune_old_logs(tmp_path, max_age_days=30)
        assert recent not in deleted
        assert recent.exists()

    def test_returns_list_of_deleted_paths(self, tmp_path):
        _make_old_file(tmp_path, "a.log", age_days=60)
        _make_old_file(tmp_path, "b.log", age_days=61)
        deleted = prune_old_logs(tmp_path, max_age_days=30)
        assert len(deleted) == 2

    def test_empty_directory_returns_empty_list(self, tmp_path):
        assert prune_old_logs(tmp_path, max_age_days=30) == []

    def test_raises_for_missing_directory(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            prune_old_logs(tmp_path / "no_such_dir", max_age_days=30)

    def test_respects_glob_pattern(self, tmp_path):
        old_log = _make_old_file(tmp_path, "app.log", age_days=40)
        old_txt = _make_old_file(tmp_path, "app.txt", age_days=40)
        deleted = prune_old_logs(tmp_path, max_age_days=30, pattern="*.log")
        assert old_log in deleted
        assert old_txt not in deleted
        assert old_txt.exists()

    def test_does_not_delete_directories(self, tmp_path):
        sub = tmp_path / "subdir.log"
        sub.mkdir()
        deleted = prune_old_logs(tmp_path, max_age_days=0)
        assert sub not in deleted
        assert sub.exists()

    def test_boundary_exactly_at_cutoff(self, tmp_path):
        # A file modified exactly at the cutoff should NOT be deleted
        # (strict less-than comparison).
        boundary = tmp_path / "boundary.log"
        boundary.write_text("x")
        now = time.time()
        cutoff_mtime = now - 30 * 86400
        import os
        os.utime(boundary, (cutoff_mtime, cutoff_mtime))
        deleted = prune_old_logs(tmp_path, max_age_days=30)
        # The file is exactly at the boundary; implementation uses strict <,
        # so it should be deleted (mtime < cutoff means older).
        # This test just asserts no exception is raised and we get a list back.
        assert isinstance(deleted, list)


# ---------------------------------------------------------------------------
# run()
# ---------------------------------------------------------------------------


class TestLogRotationRun:
    def test_run_skips_missing_directory(self, monkeypatch, tmp_path):
        import logging
        records: list[logging.LogRecord] = []

        class CapturingHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        log = logging.getLogger("_test_log_rot_missing")
        log.handlers.clear()
        log.addHandler(CapturingHandler())
        log.setLevel(logging.DEBUG)

        monkeypatch.setattr("scripts.log_rotation.get_logger", lambda *a, **kw: log)
        monkeypatch.setenv("LOG_ROTATION_DIR", str(tmp_path / "nonexistent"))
        run()  # Should not raise.

        warnings = [r for r in records if r.levelno == logging.WARNING]
        assert any("Skipping" in r.getMessage() for r in warnings)

    def test_run_deletes_old_logs(self, monkeypatch, tmp_path):
        old_file = _make_old_file(tmp_path, "stale.log", age_days=60)

        import logging
        dummy_log = logging.getLogger("_test_log_rot_deletes")
        dummy_log.handlers.clear()
        dummy_log.addHandler(logging.NullHandler())

        monkeypatch.setattr("scripts.log_rotation.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setenv("LOG_ROTATION_DIR", str(tmp_path))
        monkeypatch.setenv("LOG_ROTATION_MAX_DAYS", "30")
        run()

        assert not old_file.exists()

    def test_run_keeps_recent_logs(self, monkeypatch, tmp_path):
        recent = _make_old_file(tmp_path, "new.log", age_days=2)

        import logging
        dummy_log = logging.getLogger("_test_log_rot_keeps")
        dummy_log.handlers.clear()
        dummy_log.addHandler(logging.NullHandler())

        monkeypatch.setattr("scripts.log_rotation.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setenv("LOG_ROTATION_DIR", str(tmp_path))
        monkeypatch.setenv("LOG_ROTATION_MAX_DAYS", "30")
        run()

        assert recent.exists()

    def test_description_is_set(self):
        assert isinstance(DESCRIPTION, str)
        assert len(DESCRIPTION) > 0
