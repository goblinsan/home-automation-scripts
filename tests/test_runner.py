"""Tests for tools/runner.py."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from types import ModuleType

import pytest

# Ensure repo root is on sys.path before importing project modules.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.runner import discover_tasks, list_tasks, run_task, main


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def scripts_dir(tmp_path):
    """Return an empty temporary directory to use as a scripts directory."""
    d = tmp_path / "scripts"
    d.mkdir()
    return d


@pytest.fixture()
def logger(tmp_path):
    """Return a logger that writes only to a temp file, not console."""
    import logging

    log = logging.getLogger("test_runner_logger")
    for h in list(log.handlers):
        h.close()
        log.removeHandler(h)
    log.setLevel(logging.DEBUG)
    fh = logging.FileHandler(tmp_path / "runner.log")
    fh.setLevel(logging.DEBUG)
    log.addHandler(fh)
    yield log
    for h in list(log.handlers):
        h.close()
        log.removeHandler(h)


# ---------------------------------------------------------------------------
# discover_tasks
# ---------------------------------------------------------------------------


class TestDiscoverTasks:
    def test_empty_dir_returns_empty_dict(self, scripts_dir):
        assert discover_tasks(scripts_dir) == {}

    def test_discovers_valid_task(self, scripts_dir):
        (scripts_dir / "hello.py").write_text(
            "DESCRIPTION = 'Hello task'\ndef run():\n    pass\n"
        )
        tasks = discover_tasks(scripts_dir)
        assert "hello" in tasks

    def test_ignores_files_without_run(self, scripts_dir):
        (scripts_dir / "no_run.py").write_text("x = 1\n")
        tasks = discover_tasks(scripts_dir)
        assert "no_run" not in tasks

    def test_ignores_underscore_prefixed_files(self, scripts_dir):
        (scripts_dir / "_helper.py").write_text("def run():\n    pass\n")
        tasks = discover_tasks(scripts_dir)
        assert "_helper" not in tasks

    def test_ignores_broken_scripts(self, scripts_dir):
        (scripts_dir / "broken.py").write_text("def run():\n    raise SyntaxError\nimport this that\n")
        # Should not raise; broken script is skipped.
        tasks = discover_tasks(scripts_dir)
        assert "broken" not in tasks

    def test_returns_multiple_tasks_sorted(self, scripts_dir):
        for name in ("zebra", "apple", "mango"):
            (scripts_dir / f"{name}.py").write_text(f"def run():\n    pass\n")
        tasks = discover_tasks(scripts_dir)
        assert list(tasks.keys()) == ["apple", "mango", "zebra"]

    def test_nonexistent_dir_returns_empty_dict(self, tmp_path):
        assert discover_tasks(tmp_path / "nonexistent") == {}

    def test_task_module_has_description(self, scripts_dir):
        (scripts_dir / "described.py").write_text(
            "DESCRIPTION = 'Does something'\ndef run():\n    pass\n"
        )
        tasks = discover_tasks(scripts_dir)
        assert tasks["described"].DESCRIPTION == "Does something"


# ---------------------------------------------------------------------------
# list_tasks
# ---------------------------------------------------------------------------


class TestListTasks:
    def test_empty_tasks_prints_no_tasks_message(self, capsys):
        list_tasks({})
        out = capsys.readouterr().out
        assert "No tasks found" in out

    def test_lists_task_names(self, scripts_dir, capsys):
        mod = ModuleType("alpha")
        mod.run = lambda: None
        tasks = {"alpha": mod}
        list_tasks(tasks)
        out = capsys.readouterr().out
        assert "alpha" in out

    def test_lists_description(self, scripts_dir, capsys):
        mod = ModuleType("beta")
        mod.run = lambda: None
        mod.DESCRIPTION = "Does beta things"
        tasks = {"beta": mod}
        list_tasks(tasks)
        out = capsys.readouterr().out
        assert "Does beta things" in out

    def test_shows_no_description_placeholder(self, capsys):
        mod = ModuleType("gamma")
        mod.run = lambda: None
        list_tasks({"gamma": mod})
        out = capsys.readouterr().out
        assert "(no description)" in out


# ---------------------------------------------------------------------------
# run_task
# ---------------------------------------------------------------------------


class TestRunTask:
    def test_returns_true_on_success(self, logger):
        mod = ModuleType("ok_task")
        mod.run = lambda: None
        assert run_task("ok_task", {"ok_task": mod}, logger) is True

    def test_returns_false_for_unknown_task(self, logger):
        assert run_task("missing", {}, logger) is False

    def test_returns_false_when_task_raises(self, logger):
        mod = ModuleType("fail_task")
        mod.run = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        assert run_task("fail_task", {"fail_task": mod}, logger) is False

    def test_exception_logged_on_failure(self, tmp_path, logger):
        mod = ModuleType("err_task")
        mod.run = lambda: (_ for _ in ()).throw(ValueError("bad value"))
        run_task("err_task", {"err_task": mod}, logger)
        log_file = tmp_path / "runner.log"
        content = log_file.read_text()
        assert "bad value" in content

    def test_success_logged(self, tmp_path, logger):
        mod = ModuleType("log_task")
        mod.run = lambda: None
        run_task("log_task", {"log_task": mod}, logger)
        log_file = tmp_path / "runner.log"
        content = log_file.read_text()
        assert "log_task" in content


# ---------------------------------------------------------------------------
# main (CLI)
# ---------------------------------------------------------------------------


class TestMain:
    def test_list_command_returns_zero(self, scripts_dir, monkeypatch):
        monkeypatch.setattr("tools.runner._SCRIPTS_DIR", scripts_dir)
        assert main(["list"]) == 0

    def test_run_unknown_task_returns_one(self, scripts_dir, monkeypatch):
        monkeypatch.setattr("tools.runner._SCRIPTS_DIR", scripts_dir)
        assert main(["run", "no_such_task"]) == 1

    def test_run_valid_task_returns_zero(self, scripts_dir, monkeypatch, tmp_path):
        (scripts_dir / "greet.py").write_text("def run():\n    print('hi')\n")
        monkeypatch.setattr("tools.runner._SCRIPTS_DIR", scripts_dir)

        # Patch get_logger to avoid writing to the real logs/ directory.
        import logging
        dummy_log = logging.getLogger("_test_main_greet")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("tools.runner.get_logger", lambda *a, **kw: dummy_log)

        assert main(["run", "greet"]) == 0

    def test_run_failing_task_returns_one(self, scripts_dir, monkeypatch, tmp_path):
        (scripts_dir / "bad.py").write_text(
            "def run():\n    raise RuntimeError('oops')\n"
        )
        monkeypatch.setattr("tools.runner._SCRIPTS_DIR", scripts_dir)

        import logging
        dummy_log = logging.getLogger("_test_main_bad")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("tools.runner.get_logger", lambda *a, **kw: dummy_log)

        assert main(["run", "bad"]) == 1

    def test_mixed_tasks_returns_one_on_partial_failure(
        self, scripts_dir, monkeypatch
    ):
        (scripts_dir / "good.py").write_text("def run():\n    pass\n")
        (scripts_dir / "evil.py").write_text(
            "def run():\n    raise ValueError('nope')\n"
        )
        monkeypatch.setattr("tools.runner._SCRIPTS_DIR", scripts_dir)

        import logging
        dummy_log = logging.getLogger("_test_main_mixed")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("tools.runner.get_logger", lambda *a, **kw: dummy_log)

        assert main(["run", "good", "evil"]) == 1

    def test_no_subcommand_exits_with_error(self):
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code != 0
