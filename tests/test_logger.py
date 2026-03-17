"""Tests for tools/logger.py."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

# Ensure repo root is on sys.path before importing project modules.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.logger import get_logger


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clear_logger(name: str) -> None:
    """Remove all handlers from a logger so tests are independent."""
    logger = logging.getLogger(name)
    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestGetLogger:
    def test_returns_logger_instance(self, tmp_path):
        _clear_logger("test_instance")
        log = get_logger("test_instance", log_dir=tmp_path)
        assert isinstance(log, logging.Logger)
        _clear_logger("test_instance")

    def test_logger_name_matches_argument(self, tmp_path):
        _clear_logger("test_name")
        log = get_logger("test_name", log_dir=tmp_path)
        assert log.name == "test_name"
        _clear_logger("test_name")

    def test_creates_log_file_in_log_dir(self, tmp_path):
        _clear_logger("test_file")
        get_logger("test_file", log_dir=tmp_path)
        log_files = list(tmp_path.glob("test_file_*.log"))
        assert len(log_files) == 1, "Expected exactly one log file"
        _clear_logger("test_file")

    def test_log_file_name_starts_with_logger_name(self, tmp_path):
        _clear_logger("myapp")
        get_logger("myapp", log_dir=tmp_path)
        log_files = list(tmp_path.glob("myapp_*.log"))
        assert log_files, "Log file with correct prefix not found"
        _clear_logger("myapp")

    def test_creates_log_directory_if_missing(self, tmp_path):
        nested = tmp_path / "deep" / "nested"
        assert not nested.exists()
        _clear_logger("test_mkdir")
        get_logger("test_mkdir", log_dir=nested)
        assert nested.is_dir()
        _clear_logger("test_mkdir")

    def test_has_console_and_file_handlers(self, tmp_path):
        _clear_logger("test_handlers")
        log = get_logger("test_handlers", log_dir=tmp_path)
        handler_types = {type(h) for h in log.handlers}
        assert logging.StreamHandler in handler_types
        assert logging.FileHandler in handler_types
        _clear_logger("test_handlers")

    def test_no_duplicate_handlers_on_repeated_calls(self, tmp_path):
        _clear_logger("test_dedup")
        get_logger("test_dedup", log_dir=tmp_path)
        get_logger("test_dedup", log_dir=tmp_path)
        log = logging.getLogger("test_dedup")
        assert len(log.handlers) == 2, "Expected exactly 2 handlers (console + file)"
        _clear_logger("test_dedup")

    def test_messages_written_to_log_file(self, tmp_path):
        _clear_logger("test_write")
        log = get_logger("test_write", log_dir=tmp_path)
        log.debug("debug message")
        log.info("info message")
        # Flush file handlers.
        for handler in log.handlers:
            handler.flush()
        log_file = next(tmp_path.glob("test_write_*.log"))
        content = log_file.read_text()
        assert "debug message" in content
        assert "info message" in content
        _clear_logger("test_write")

    def test_console_level_default_is_info(self, tmp_path):
        _clear_logger("test_console_level")
        log = get_logger("test_console_level", log_dir=tmp_path)
        stream_handlers = [
            h for h in log.handlers if type(h) is logging.StreamHandler
        ]
        assert stream_handlers, "No StreamHandler found"
        assert stream_handlers[0].level == logging.INFO
        _clear_logger("test_console_level")

    def test_file_level_default_is_debug(self, tmp_path):
        _clear_logger("test_file_level")
        log = get_logger("test_file_level", log_dir=tmp_path)
        file_handlers = [h for h in log.handlers if isinstance(h, logging.FileHandler)]
        assert file_handlers, "No FileHandler found"
        assert file_handlers[0].level == logging.DEBUG
        _clear_logger("test_file_level")

    def test_custom_console_and_file_levels(self, tmp_path):
        _clear_logger("test_custom_levels")
        log = get_logger(
            "test_custom_levels",
            log_dir=tmp_path,
            console_level=logging.WARNING,
            file_level=logging.ERROR,
        )
        stream_handlers = [
            h for h in log.handlers if type(h) is logging.StreamHandler
        ]
        file_handlers = [h for h in log.handlers if isinstance(h, logging.FileHandler)]
        assert stream_handlers[0].level == logging.WARNING
        assert file_handlers[0].level == logging.ERROR
        _clear_logger("test_custom_levels")
