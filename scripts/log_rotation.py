#!/usr/bin/env python3
"""
scripts/log_rotation.py – Log rotation / pruning script.

Automatically removes log files older than a configurable number of days from
the repository's ``logs/`` directory (or any other directory you configure).

Usage (via automation CLI):
    python3 tools/automation.py run log-rotation

Usage (direct):
    python3 scripts/log_rotation.py

Environment variables (optional):
    LOG_ROTATION_DIR        Directory to prune.  Defaults to ``logs/`` at the
                            repository root.
    LOG_ROTATION_MAX_DAYS   Files older than this many days are deleted.
                            Defaults to 30.
    LOG_ROTATION_PATTERN    Glob pattern to match log files.
                            Defaults to ``*.log``.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "Automatically prune old log files"

_DEFAULT_MAX_DAYS = 30
_DEFAULT_PATTERN = "*.log"


# ---------------------------------------------------------------------------
# Pruning helper
# ---------------------------------------------------------------------------


def prune_old_logs(
    log_dir: str | Path,
    max_age_days: float,
    pattern: str = _DEFAULT_PATTERN,
) -> list[Path]:
    """Delete log files in *log_dir* that are older than *max_age_days*.

    Only files matching *pattern* (a :meth:`Path.glob` glob) are considered.
    Directories and non-matching files are left untouched.

    Args:
        log_dir: Directory containing log files.
        max_age_days: Files last modified more than this many days ago are
            deleted.
        pattern: Glob pattern used to select files.  Defaults to ``*.log``.

    Returns:
        A list of :class:`Path` objects for every file that was successfully
        deleted.

    Raises:
        FileNotFoundError: If *log_dir* does not exist.
    """
    target = Path(log_dir)
    if not target.is_dir():
        raise FileNotFoundError(f"Log directory not found: {target}")

    cutoff = time.time() - max_age_days * 86400
    deleted: list[Path] = []

    for file_path in sorted(target.glob(pattern)):
        if not file_path.is_file():
            continue
        if file_path.stat().st_mtime < cutoff:
            try:
                file_path.unlink()
                deleted.append(file_path)
            except OSError:
                pass  # Logged by the caller via the returned list vs directory scan

    return deleted


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run() -> None:
    """Entry point called by the automation runner.

    Reads configuration from environment variables and prunes old log files.
    """
    log = get_logger("log-rotation")

    default_log_dir = str(_REPO_ROOT / "logs")
    log_dir = os.environ.get("LOG_ROTATION_DIR", default_log_dir)
    max_days = float(os.environ.get("LOG_ROTATION_MAX_DAYS", _DEFAULT_MAX_DAYS))
    pattern = os.environ.get("LOG_ROTATION_PATTERN", _DEFAULT_PATTERN)

    log.info(
        "Log rotation: dir=%s, max_age=%.0f days, pattern=%s",
        log_dir,
        max_days,
        pattern,
    )

    try:
        deleted = prune_old_logs(log_dir, max_days, pattern)
    except FileNotFoundError as exc:
        log.warning("Skipping log rotation – %s", exc)
        return

    if deleted:
        log.info("Deleted %d old log file(s):", len(deleted))
        for path in deleted:
            log.info("  Removed: %s", path.name)
    else:
        log.info("No log files older than %.0f days found.", max_days)


if __name__ == "__main__":
    run()
