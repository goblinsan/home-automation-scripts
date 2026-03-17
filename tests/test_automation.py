"""Tests for tools/automation.py."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

# Ensure repo root is on sys.path before importing project modules.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.automation import main


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_registry(tmp_path: Path, content: str) -> Path:
    reg = tmp_path / "tools_registry.yaml"
    reg.write_text(content, encoding="utf-8")
    return reg


def _write_script(directory: Path, name: str, raises: bool = False) -> Path:
    if raises:
        body = f"def run():\n    raise RuntimeError('{name} failed')\n"
    else:
        body = f"DESCRIPTION = '{name} tool'\ndef run():\n    pass\n"
    p = directory / f"{name}.py"
    p.write_text(body, encoding="utf-8")
    return p


def _null_logger(name: str) -> logging.Logger:
    log = logging.getLogger(name)
    for h in list(log.handlers):
        h.close()
        log.removeHandler(h)
    log.addHandler(logging.NullHandler())
    return log


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class TestAutomationMain:
    def test_list_command_returns_zero(self, tmp_path, monkeypatch, capsys):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "alpha")

        reg = _write_registry(
            tmp_path,
            f"tools:\n  - name: alpha\n    script: scripts/alpha.py\n",
        )
        monkeypatch.setattr(
            "tools.registry._DEFAULT_REGISTRY", reg
        )
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger", lambda *a, **kw: _null_logger("_test_auto_list")
        )

        assert main(["list"]) == 0
        out = capsys.readouterr().out
        assert "alpha" in out

    def test_list_empty_registry_returns_zero(self, tmp_path, monkeypatch, capsys):
        reg = _write_registry(tmp_path, "tools: []\n")
        monkeypatch.setattr("tools.registry._DEFAULT_REGISTRY", reg)
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger", lambda *a, **kw: _null_logger("_test_auto_empty")
        )

        assert main(["list"]) == 0
        out = capsys.readouterr().out
        assert "No tasks found" in out

    def test_run_valid_tool_returns_zero(self, tmp_path, monkeypatch):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "mytool")

        reg = _write_registry(
            tmp_path,
            f"tools:\n  - name: mytool\n    script: scripts/mytool.py\n",
        )
        monkeypatch.setattr("tools.registry._DEFAULT_REGISTRY", reg)
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger", lambda *a, **kw: _null_logger("_test_auto_run")
        )

        assert main(["run", "mytool"]) == 0

    def test_run_unknown_tool_returns_one(self, tmp_path, monkeypatch):
        reg = _write_registry(tmp_path, "tools: []\n")
        monkeypatch.setattr("tools.registry._DEFAULT_REGISTRY", reg)
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger",
            lambda *a, **kw: _null_logger("_test_auto_unknown"),
        )

        assert main(["run", "no-such-tool"]) == 1

    def test_run_failing_tool_returns_one(self, tmp_path, monkeypatch):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "bad", raises=True)

        reg = _write_registry(
            tmp_path,
            f"tools:\n  - name: bad\n    script: scripts/bad.py\n",
        )
        monkeypatch.setattr("tools.registry._DEFAULT_REGISTRY", reg)
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger",
            lambda *a, **kw: _null_logger("_test_auto_fail"),
        )

        assert main(["run", "bad"]) == 1

    def test_run_multiple_tools_partial_failure_returns_one(self, tmp_path, monkeypatch):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "good")
        _write_script(scripts_dir, "evil", raises=True)

        reg = _write_registry(
            tmp_path,
            (
                "tools:\n"
                "  - name: good\n    script: scripts/good.py\n"
                "  - name: evil\n    script: scripts/evil.py\n"
            ),
        )
        monkeypatch.setattr("tools.registry._DEFAULT_REGISTRY", reg)
        monkeypatch.setattr("tools.registry._REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            "tools.automation.get_logger",
            lambda *a, **kw: _null_logger("_test_auto_mixed"),
        )

        assert main(["run", "good", "evil"]) == 1

    def test_no_subcommand_exits_with_error(self):
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code != 0
