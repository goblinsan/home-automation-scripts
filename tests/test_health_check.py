"""Tests for scripts/health_check.py."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.health_check import (
    get_disk_usage,
    get_memory_usage,
    get_cpu_percent,
    run,
    DESCRIPTION,
)


# ---------------------------------------------------------------------------
# get_disk_usage
# ---------------------------------------------------------------------------


class TestGetDiskUsage:
    def test_returns_expected_keys(self, tmp_path):
        result = get_disk_usage(str(tmp_path))
        assert set(result.keys()) == {"total_gb", "used_gb", "free_gb", "percent_used"}

    def test_percent_used_in_range(self, tmp_path):
        result = get_disk_usage(str(tmp_path))
        assert 0.0 <= result["percent_used"] <= 100.0

    def test_total_equals_used_plus_free(self, tmp_path):
        result = get_disk_usage(str(tmp_path))
        assert abs(result["total_gb"] - result["used_gb"] - result["free_gb"]) < 0.1

    def test_uses_shutil_disk_usage(self, tmp_path):
        import shutil

        real = shutil.disk_usage(str(tmp_path))
        result = get_disk_usage(str(tmp_path))
        assert abs(result["total_gb"] - real.total / 1024 ** 3) < 0.001


# ---------------------------------------------------------------------------
# get_memory_usage
# ---------------------------------------------------------------------------


class TestGetMemoryUsage:
    def test_returns_expected_keys(self):
        result = get_memory_usage()
        assert set(result.keys()) == {"total_mb", "available_mb", "used_mb", "percent_used"}

    def test_percent_used_in_range(self):
        result = get_memory_usage()
        assert 0.0 <= result["percent_used"] <= 100.0

    def test_fallback_when_proc_meminfo_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "scripts.health_check.Path",
            lambda p: tmp_path / "no_such_file" if "meminfo" in str(p) else Path(p),
        )
        # Should not raise; falls back to zeros.
        result = get_memory_usage()
        assert isinstance(result["percent_used"], float)

    def test_proc_meminfo_unavailable_returns_zeros(self, monkeypatch):
        fake_path = Path("/nonexistent_proc_meminfo_xyz")
        monkeypatch.setattr("scripts.health_check.Path", lambda p: fake_path if "meminfo" in str(p) else Path(p))
        result = get_memory_usage()
        assert result["total_mb"] == 0.0
        assert result["percent_used"] == 0.0


# ---------------------------------------------------------------------------
# get_cpu_percent
# ---------------------------------------------------------------------------


class TestGetCpuPercent:
    def test_returns_float(self, monkeypatch):
        # Patch time.sleep to avoid a real 1-second delay in tests.
        monkeypatch.setattr("scripts.health_check.time.sleep", lambda _: None)
        result = get_cpu_percent()
        assert isinstance(result, float)

    def test_fallback_when_proc_stat_missing(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.health_check.Path",
            lambda p: Path("/nonexistent") if "proc/stat" in str(p) else Path(p),
        )
        result = get_cpu_percent()
        assert result == 0.0

    def test_result_in_range(self, monkeypatch):
        monkeypatch.setattr("scripts.health_check.time.sleep", lambda _: None)
        result = get_cpu_percent()
        assert 0.0 <= result <= 100.0


# ---------------------------------------------------------------------------
# run()
# ---------------------------------------------------------------------------


class TestHealthCheckRun:
    def test_run_completes_without_error(self, monkeypatch, tmp_path):
        monkeypatch.setattr("scripts.health_check.time.sleep", lambda _: None)
        # Redirect logs to tmp_path to avoid side effects.
        import logging
        dummy_log = logging.getLogger("_test_health_run")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.health_check.get_logger", lambda *a, **kw: dummy_log)
        run()  # Should not raise.

    def test_run_warns_on_high_disk(self, monkeypatch, tmp_path):
        import logging
        records: list[logging.LogRecord] = []

        class CapturingHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        log = logging.getLogger("_test_health_disk_warn")
        log.handlers.clear()
        log.addHandler(CapturingHandler())
        log.setLevel(logging.DEBUG)

        monkeypatch.setattr("scripts.health_check.get_logger", lambda *a, **kw: log)
        monkeypatch.setattr("scripts.health_check.time.sleep", lambda _: None)
        # Force disk usage to 99%
        monkeypatch.setattr(
            "scripts.health_check.get_disk_usage",
            lambda *a, **kw: {
                "total_gb": 100.0,
                "used_gb": 99.0,
                "free_gb": 1.0,
                "percent_used": 99.0,
            },
        )
        monkeypatch.setenv("HEALTH_DISK_WARN_PCT", "80")
        run()

        warnings = [r for r in records if r.levelno == logging.WARNING]
        assert any("Disk" in r.getMessage() for r in warnings)

    def test_run_warns_on_high_memory(self, monkeypatch, tmp_path):
        import logging
        records: list[logging.LogRecord] = []

        class CapturingHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        log = logging.getLogger("_test_health_mem_warn")
        log.handlers.clear()
        log.addHandler(CapturingHandler())
        log.setLevel(logging.DEBUG)

        monkeypatch.setattr("scripts.health_check.get_logger", lambda *a, **kw: log)
        monkeypatch.setattr("scripts.health_check.time.sleep", lambda _: None)
        monkeypatch.setattr(
            "scripts.health_check.get_memory_usage",
            lambda: {
                "total_mb": 8192.0,
                "used_mb": 7500.0,
                "available_mb": 692.0,
                "percent_used": 92.0,
            },
        )
        monkeypatch.setenv("HEALTH_MEM_WARN_PCT", "85")
        run()

        warnings = [r for r in records if r.levelno == logging.WARNING]
        assert any("Memory" in r.getMessage() for r in warnings)

    def test_description_is_set(self):
        assert isinstance(DESCRIPTION, str)
        assert len(DESCRIPTION) > 0
