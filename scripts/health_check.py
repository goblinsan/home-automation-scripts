#!/usr/bin/env python3
"""
scripts/health_check.py – System health check script.

Monitors disk usage, CPU load, and memory utilization and logs a summary.
Warns when any metric exceeds its configured threshold.

Usage (via automation CLI):
    python3 tools/automation.py run health-check

Usage (direct):
    python3 scripts/health_check.py

Environment variables (optional):
    HEALTH_DISK_WARN_PCT   Disk usage percentage that triggers a warning.
                           Defaults to 80.
    HEALTH_CPU_WARN_PCT    CPU usage percentage that triggers a warning.
                           Defaults to 90.
    HEALTH_MEM_WARN_PCT    Memory usage percentage that triggers a warning.
                           Defaults to 85.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "Monitor disk usage, CPU load, and memory utilization"

_DEFAULT_DISK_WARN_PCT = 80
_DEFAULT_CPU_WARN_PCT = 90
_DEFAULT_MEM_WARN_PCT = 85


# ---------------------------------------------------------------------------
# Metric collection helpers
# ---------------------------------------------------------------------------


def get_disk_usage(path: str = "/") -> dict[str, float]:
    """Return disk usage statistics for *path*.

    Args:
        path: Filesystem path to check.  Defaults to the root filesystem.

    Returns:
        A dict with keys ``total_gb``, ``used_gb``, ``free_gb``, and
        ``percent_used``.
    """
    usage = shutil.disk_usage(path)
    gb = 1024 ** 3
    return {
        "total_gb": usage.total / gb,
        "used_gb": usage.used / gb,
        "free_gb": usage.free / gb,
        "percent_used": usage.used / usage.total * 100,
    }


def get_cpu_percent() -> float:
    """Return the current system-wide CPU utilisation as a percentage.

    Uses ``/proc/stat`` on Linux-like systems for a one-second average.
    Falls back to 0.0 if the file is unavailable (e.g. macOS without psutil).

    Returns:
        CPU utilisation percentage (0.0 – 100.0).
    """
    proc_stat = Path("/proc/stat")
    if not proc_stat.exists():
        return 0.0

    def _read_cpu_times() -> tuple[int, int]:
        line = proc_stat.read_text(encoding="utf-8").splitlines()[0]
        fields = [int(x) for x in line.split()[1:]]
        idle = fields[3]
        total = sum(fields)
        return idle, total

    idle1, total1 = _read_cpu_times()
    time.sleep(1)
    idle2, total2 = _read_cpu_times()

    idle_delta = idle2 - idle1
    total_delta = total2 - total1
    if total_delta == 0:
        return 0.0
    return (1.0 - idle_delta / total_delta) * 100.0


def get_memory_usage() -> dict[str, float]:
    """Return memory usage statistics from ``/proc/meminfo``.

    Falls back to returning zeros if ``/proc/meminfo`` is unavailable.

    Returns:
        A dict with keys ``total_mb``, ``available_mb``, ``used_mb``, and
        ``percent_used``.
    """
    meminfo_path = Path("/proc/meminfo")
    if not meminfo_path.exists():
        return {"total_mb": 0.0, "available_mb": 0.0, "used_mb": 0.0, "percent_used": 0.0}

    values: dict[str, int] = {}
    for line in meminfo_path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            key = parts[0].rstrip(":")
            try:
                values[key] = int(parts[1])
            except ValueError:
                pass

    total_kb = values.get("MemTotal", 0)
    available_kb = values.get("MemAvailable", values.get("MemFree", 0))
    used_kb = total_kb - available_kb
    mb = 1024

    if total_kb == 0:
        percent_used = 0.0
    else:
        percent_used = used_kb / total_kb * 100.0

    return {
        "total_mb": total_kb / mb,
        "available_mb": available_kb / mb,
        "used_mb": used_kb / mb,
        "percent_used": percent_used,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run() -> None:
    """Entry point called by the automation runner.

    Collects disk, CPU, and memory metrics and logs a summary.  Logs a
    WARNING for any metric that exceeds its configured threshold.
    """
    log = get_logger("health-check")

    disk_warn = float(os.environ.get("HEALTH_DISK_WARN_PCT", _DEFAULT_DISK_WARN_PCT))
    cpu_warn = float(os.environ.get("HEALTH_CPU_WARN_PCT", _DEFAULT_CPU_WARN_PCT))
    mem_warn = float(os.environ.get("HEALTH_MEM_WARN_PCT", _DEFAULT_MEM_WARN_PCT))

    log.info("=== System Health Check ===")

    # -- Disk --
    disk = get_disk_usage()
    log.info(
        "Disk (/): %.1f GB total, %.1f GB used, %.1f GB free (%.1f%%)",
        disk["total_gb"],
        disk["used_gb"],
        disk["free_gb"],
        disk["percent_used"],
    )
    if disk["percent_used"] >= disk_warn:
        log.warning(
            "Disk usage is %.1f%% – exceeds warning threshold of %.0f%%",
            disk["percent_used"],
            disk_warn,
        )

    # -- CPU --
    cpu_pct = get_cpu_percent()
    log.info("CPU load: %.1f%%", cpu_pct)
    if cpu_pct >= cpu_warn:
        log.warning(
            "CPU usage is %.1f%% – exceeds warning threshold of %.0f%%",
            cpu_pct,
            cpu_warn,
        )

    # -- Memory --
    mem = get_memory_usage()
    log.info(
        "Memory: %.0f MB total, %.0f MB used, %.0f MB available (%.1f%%)",
        mem["total_mb"],
        mem["used_mb"],
        mem["available_mb"],
        mem["percent_used"],
    )
    if mem["percent_used"] >= mem_warn:
        log.warning(
            "Memory usage is %.1f%% – exceeds warning threshold of %.0f%%",
            mem["percent_used"],
            mem_warn,
        )

    log.info("=== Health check complete ===")


if __name__ == "__main__":
    run()
