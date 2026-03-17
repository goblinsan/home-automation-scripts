#!/usr/bin/env python3
"""
tools/logger.py – Centralised logging setup for home-automation-scripts.

Usage (import into any project script or tool):
    from tools.logger import get_logger

    log = get_logger("my_script")
    log.info("Starting …")
    log.error("Something went wrong: %s", exc)

What it does:
    1. Returns a :class:`logging.Logger` configured with two handlers:
       - A console (stderr) handler at INFO level for immediate feedback.
       - A rotating file handler at DEBUG level that writes to the ``logs/``
         directory at the repository root using a timestamped filename.
    2. Creates the ``logs/`` directory automatically if it does not exist.
    3. Guards against adding duplicate handlers when the same logger name is
       requested more than once in a single process.

Log file naming:
    logs/<name>_<YYYYMMDD_HHMMSS>.log

Log message format:
    2026-01-02 03:04:05 [INFO ] my_script: message text
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_LOG_FORMAT = "%(asctime)s [%(levelname)-5s] %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# Default log directory: <repo_root>/logs/
_DEFAULT_LOG_DIR: Path = Path(__file__).resolve().parent.parent / "logs"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_logger(
    name: str,
    log_dir: str | Path | None = None,
    console_level: int = logging.INFO,
    file_level: int = logging.DEBUG,
) -> logging.Logger:
    """Return a logger that writes to the console and a timestamped log file.

    Calling ``get_logger`` with the same *name* more than once within a
    process returns the same underlying :class:`logging.Logger` without
    adding duplicate handlers.

    Args:
        name: Logger name used in log messages and as part of the log filename.
            Typically the script or task name (e.g. ``"backup"``).
        log_dir: Directory where log files are written.  Defaults to the
            ``logs/`` directory at the repository root.  Created automatically
            if it does not exist.
        console_level: Logging level for the console (stderr) handler.
            Defaults to :data:`logging.INFO`.
        file_level: Logging level for the file handler.
            Defaults to :data:`logging.DEBUG`.

    Returns:
        A configured :class:`logging.Logger` instance.

    Raises:
        OSError: If the log directory cannot be created.
    """
    logger = logging.getLogger(name)

    # Avoid adding duplicate handlers on repeated calls for the same name.
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

    # ------------------------------------------------------------------
    # Console handler
    # ------------------------------------------------------------------
    console_handler = logging.StreamHandler()
    console_handler.setLevel(console_level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # ------------------------------------------------------------------
    # File handler
    # ------------------------------------------------------------------
    resolved_log_dir = Path(log_dir) if log_dir is not None else _DEFAULT_LOG_DIR
    resolved_log_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    log_file = resolved_log_dir / f"{name}_{timestamp}.log"

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(file_level)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger
