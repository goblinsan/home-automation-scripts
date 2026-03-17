"""Tests for tools/cron_installer.py."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Ensure repo root is on sys.path before importing project modules.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.cron_installer import (
    _MANAGED_BEGIN,
    _MANAGED_END,
    _MANAGED_WARNING,
    build_managed_block,
    cmd_install,
    cmd_list,
    cmd_uninstall,
    extract_entries,
    load_template,
    main,
    read_current_crontab,
    remove_managed_block,
    write_crontab,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def template_file(tmp_path):
    """Return a minimal crontab template in a temp directory."""
    content = (
        "# This is a comment\n"
        "\n"
        "0 2 * * * $PYTHON $REPO_ROOT/tools/runner.py run backup >> $REPO_ROOT/logs/cron.log 2>&1\n"
        "*/15 * * * * $PYTHON $REPO_ROOT/tools/runner.py run health_check >> $REPO_ROOT/logs/cron.log 2>&1\n"
    )
    f = tmp_path / "crontab.example"
    f.write_text(content)
    return f


@pytest.fixture()
def args_base(tmp_path, template_file):
    """Return a SimpleNamespace that looks like parsed CLI args."""
    return SimpleNamespace(
        repo_root=str(tmp_path),
        template=str(template_file),
    )


# ---------------------------------------------------------------------------
# load_template
# ---------------------------------------------------------------------------


class TestLoadTemplate:
    def test_raises_if_file_missing(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_template(tmp_path / "nonexistent.txt", tmp_path, "/usr/bin/python3")

    def test_substitutes_repo_root(self, tmp_path):
        f = tmp_path / "t.txt"
        f.write_text("0 2 * * * $REPO_ROOT/runner.py\n")
        result = load_template(f, tmp_path, "/usr/bin/python3")
        assert "$REPO_ROOT" not in result
        assert str(tmp_path) in result

    def test_substitutes_python(self, tmp_path):
        f = tmp_path / "t.txt"
        f.write_text("0 2 * * * $PYTHON runner.py\n")
        result = load_template(f, tmp_path, "/usr/bin/python3")
        assert "$PYTHON" not in result
        assert "/usr/bin/python3" in result

    def test_substitutes_both_variables(self, tmp_path):
        f = tmp_path / "t.txt"
        f.write_text("0 2 * * * $PYTHON $REPO_ROOT/runner.py\n")
        result = load_template(f, tmp_path, "/my/python")
        assert "$PYTHON" not in result
        assert "$REPO_ROOT" not in result
        assert "/my/python" in result
        assert str(tmp_path) in result

    def test_preserves_comments(self, tmp_path):
        f = tmp_path / "t.txt"
        f.write_text("# just a comment\n0 * * * * cmd\n")
        result = load_template(f, tmp_path, "/usr/bin/python3")
        assert "# just a comment" in result


# ---------------------------------------------------------------------------
# extract_entries
# ---------------------------------------------------------------------------


class TestExtractEntries:
    def test_empty_string_returns_empty_list(self):
        assert extract_entries("") == []

    def test_only_comments_returns_empty(self):
        text = "# comment 1\n# comment 2\n"
        assert extract_entries(text) == []

    def test_blank_lines_ignored(self):
        text = "\n\n  \n0 2 * * * cmd\n"
        result = extract_entries(text)
        assert result == ["0 2 * * * cmd"]

    def test_extracts_multiple_entries(self):
        text = (
            "# header\n"
            "0 2 * * * cmd1\n"
            "*/15 * * * * cmd2\n"
            "@reboot cmd3\n"
        )
        result = extract_entries(text)
        assert result == ["0 2 * * * cmd1", "*/15 * * * * cmd2", "@reboot cmd3"]

    def test_preserves_order(self):
        text = "0 1 * * * a\n0 2 * * * b\n0 3 * * * c\n"
        result = extract_entries(text)
        assert result == ["0 1 * * * a", "0 2 * * * b", "0 3 * * * c"]

    def test_inline_comment_lines_not_treated_as_entries(self):
        # Lines starting with # should never appear as entries.
        text = "# MAILTO=\"\"\n0 2 * * * cmd\n"
        result = extract_entries(text)
        assert result == ["0 2 * * * cmd"]


# ---------------------------------------------------------------------------
# read_current_crontab
# ---------------------------------------------------------------------------


class TestReadCurrentCrontab:
    def test_returns_stdout_on_success(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "0 2 * * * cmd\n"
        with patch("tools.cron_installer.subprocess.run", return_value=mock_result):
            result = read_current_crontab()
        assert result == "0 2 * * * cmd\n"

    def test_returns_empty_when_no_crontab(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        with patch("tools.cron_installer.subprocess.run", return_value=mock_result):
            result = read_current_crontab()
        assert result == ""

    def test_calls_crontab_l(self):
        mock_result = MagicMock(returncode=0, stdout="")
        with patch(
            "tools.cron_installer.subprocess.run", return_value=mock_result
        ) as mock_run:
            read_current_crontab()
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        assert call_args == ["crontab", "-l"]


# ---------------------------------------------------------------------------
# write_crontab
# ---------------------------------------------------------------------------


class TestWriteCrontab:
    def test_calls_crontab_stdin(self):
        with patch("tools.cron_installer.subprocess.run") as mock_run:
            write_crontab("0 2 * * * cmd\n")
        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args[1]
        assert call_kwargs.get("input") == "0 2 * * * cmd\n"

    def test_uses_crontab_dash(self):
        with patch("tools.cron_installer.subprocess.run") as mock_run:
            write_crontab("content")
        call_args = mock_run.call_args[0][0]
        assert call_args == ["crontab", "-"]

    def test_propagates_called_process_error(self):
        with patch(
            "tools.cron_installer.subprocess.run",
            side_effect=subprocess.CalledProcessError(1, "crontab"),
        ):
            with pytest.raises(subprocess.CalledProcessError):
                write_crontab("content")


# ---------------------------------------------------------------------------
# remove_managed_block
# ---------------------------------------------------------------------------


class TestRemoveManagedBlock:
    def test_no_block_returns_unchanged(self):
        crontab = "0 2 * * * cmd\n"
        assert remove_managed_block(crontab) == crontab

    def test_removes_entire_block(self):
        crontab = (
            "0 2 * * * before\n"
            f"{_MANAGED_BEGIN}\n"
            "0 3 * * * managed\n"
            f"{_MANAGED_END}\n"
            "0 4 * * * after\n"
        )
        result = remove_managed_block(crontab)
        assert "managed" not in result
        assert "before" in result
        assert "after" in result

    def test_removes_only_managed_lines(self):
        crontab = (
            f"{_MANAGED_BEGIN}\n"
            "0 5 * * * inside\n"
            f"{_MANAGED_END}\n"
        )
        assert remove_managed_block(crontab) == ""

    def test_preserves_lines_before_block(self):
        crontab = (
            "# user comment\n"
            "0 1 * * * user_job\n"
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed_job\n"
            f"{_MANAGED_END}\n"
        )
        result = remove_managed_block(crontab)
        assert "user_job" in result
        assert "user comment" in result
        assert "managed_job" not in result

    def test_preserves_lines_after_block(self):
        crontab = (
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed\n"
            f"{_MANAGED_END}\n"
            "0 6 * * * after\n"
        )
        result = remove_managed_block(crontab)
        assert "after" in result
        assert "managed" not in result

    def test_empty_string_returns_empty(self):
        assert remove_managed_block("") == ""


# ---------------------------------------------------------------------------
# build_managed_block
# ---------------------------------------------------------------------------


class TestBuildManagedBlock:
    def test_includes_begin_marker(self):
        block = build_managed_block(["0 2 * * * cmd"])
        assert _MANAGED_BEGIN in block

    def test_includes_end_marker(self):
        block = build_managed_block(["0 2 * * * cmd"])
        assert _MANAGED_END in block

    def test_includes_warning_comment(self):
        block = build_managed_block(["0 2 * * * cmd"])
        assert _MANAGED_WARNING in block

    def test_includes_all_entries(self):
        entries = ["0 2 * * * cmd1", "*/15 * * * * cmd2"]
        block = build_managed_block(entries)
        assert "cmd1" in block
        assert "cmd2" in block

    def test_empty_entries_still_has_markers(self):
        block = build_managed_block([])
        assert _MANAGED_BEGIN in block
        assert _MANAGED_END in block

    def test_block_is_newline_terminated(self):
        block = build_managed_block(["0 2 * * * cmd"])
        assert block.endswith("\n")

    def test_begin_before_end(self):
        block = build_managed_block(["0 2 * * * cmd"])
        assert block.index(_MANAGED_BEGIN) < block.index(_MANAGED_END)


# ---------------------------------------------------------------------------
# cmd_list
# ---------------------------------------------------------------------------


class TestCmdList:
    def test_prints_entries(self, args_base, capsys):
        result = cmd_list(args_base)
        assert result == 0
        out = capsys.readouterr().out
        assert "runner.py" in out

    def test_returns_zero_on_success(self, args_base):
        assert cmd_list(args_base) == 0

    def test_returns_one_on_missing_template(self, tmp_path, capsys):
        args = SimpleNamespace(
            repo_root=str(tmp_path),
            template=str(tmp_path / "missing.txt"),
        )
        result = cmd_list(args)
        assert result == 1
        err = capsys.readouterr().err
        assert "ERROR" in err

    def test_prints_message_when_no_entries(self, tmp_path, capsys):
        f = tmp_path / "empty.example"
        f.write_text("# only comments\n")
        args = SimpleNamespace(repo_root=str(tmp_path), template=str(f))
        result = cmd_list(args)
        assert result == 0
        out = capsys.readouterr().out
        assert "No cron entries" in out


# ---------------------------------------------------------------------------
# cmd_install
# ---------------------------------------------------------------------------


class TestCmdInstall:
    def _make_args(self, args_base, dry_run=False):
        return SimpleNamespace(**vars(args_base), dry_run=dry_run)

    def test_dry_run_does_not_call_write(self, args_base):
        args = self._make_args(args_base, dry_run=True)
        mock_read = MagicMock(return_value="")
        with patch("tools.cron_installer.read_current_crontab", mock_read):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                cmd_install(args)
        mock_write.assert_not_called()

    def test_dry_run_shows_new_crontab(self, args_base, capsys):
        args = self._make_args(args_base, dry_run=True)
        with patch("tools.cron_installer.read_current_crontab", return_value=""):
            result = cmd_install(args)
        assert result == 0
        out = capsys.readouterr().out
        assert "[dry-run]" in out
        assert _MANAGED_BEGIN in out

    def test_installs_entries(self, args_base):
        args = self._make_args(args_base)
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=""
        ):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                result = cmd_install(args)
        assert result == 0
        written = mock_write.call_args[0][0]
        assert _MANAGED_BEGIN in written
        assert _MANAGED_END in written

    def test_replaces_existing_managed_block(self, args_base):
        existing = (
            f"{_MANAGED_BEGIN}\n"
            "0 1 * * * old_job\n"
            f"{_MANAGED_END}\n"
        )
        args = self._make_args(args_base)
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                result = cmd_install(args)
        assert result == 0
        written = mock_write.call_args[0][0]
        assert "old_job" not in written
        assert "runner.py" in written

    def test_preserves_user_entries_outside_block(self, args_base):
        existing = "0 9 * * * user_job\n"
        args = self._make_args(args_base)
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                cmd_install(args)
        written = mock_write.call_args[0][0]
        assert "user_job" in written

    def test_returns_zero_on_success(self, args_base):
        args = self._make_args(args_base)
        with patch("tools.cron_installer.read_current_crontab", return_value=""):
            with patch("tools.cron_installer.write_crontab"):
                result = cmd_install(args)
        assert result == 0

    def test_returns_one_on_missing_template(self, tmp_path, capsys):
        args = SimpleNamespace(
            repo_root=str(tmp_path),
            template=str(tmp_path / "missing.txt"),
            dry_run=False,
        )
        result = cmd_install(args)
        assert result == 1

    def test_returns_one_on_write_failure(self, args_base, capsys):
        args = self._make_args(args_base)
        with patch("tools.cron_installer.read_current_crontab", return_value=""):
            with patch(
                "tools.cron_installer.write_crontab",
                side_effect=subprocess.CalledProcessError(1, "crontab"),
            ):
                result = cmd_install(args)
        assert result == 1

    def test_returns_one_when_crontab_not_found(self, args_base, capsys):
        args = self._make_args(args_base)
        with patch(
            "tools.cron_installer.read_current_crontab",
            side_effect=FileNotFoundError("crontab not found"),
        ):
            result = cmd_install(args)
        assert result == 1
        err = capsys.readouterr().err
        assert "ERROR" in err

    def test_no_entries_skips_write(self, tmp_path, capsys):
        f = tmp_path / "empty.example"
        f.write_text("# only comments\n")
        args = SimpleNamespace(
            repo_root=str(tmp_path), template=str(f), dry_run=False
        )
        with patch("tools.cron_installer.write_crontab") as mock_write:
            result = cmd_install(args)
        mock_write.assert_not_called()
        assert result == 0


# ---------------------------------------------------------------------------
# cmd_uninstall
# ---------------------------------------------------------------------------


class TestCmdUninstall:
    def _make_args(self, dry_run=False):
        return SimpleNamespace(dry_run=dry_run)

    def test_removes_managed_block(self):
        existing = (
            "0 1 * * * user_job\n"
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed\n"
            f"{_MANAGED_END}\n"
        )
        args = self._make_args()
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                result = cmd_uninstall(args)
        assert result == 0
        written = mock_write.call_args[0][0]
        assert "managed" not in written
        assert "user_job" in written

    def test_dry_run_does_not_call_write(self):
        existing = (
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed\n"
            f"{_MANAGED_END}\n"
        )
        args = self._make_args(dry_run=True)
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            with patch("tools.cron_installer.write_crontab") as mock_write:
                cmd_uninstall(args)
        mock_write.assert_not_called()

    def test_dry_run_shows_output(self, capsys):
        existing = (
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed\n"
            f"{_MANAGED_END}\n"
        )
        args = self._make_args(dry_run=True)
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            result = cmd_uninstall(args)
        assert result == 0
        out = capsys.readouterr().out
        assert "[dry-run]" in out

    def test_no_block_prints_message(self, capsys):
        args = self._make_args()
        with patch(
            "tools.cron_installer.read_current_crontab", return_value="0 1 * * * cmd\n"
        ):
            result = cmd_uninstall(args)
        assert result == 0
        out = capsys.readouterr().out
        assert "Nothing to remove" in out

    def test_returns_one_on_write_failure(self, capsys):
        existing = (
            f"{_MANAGED_BEGIN}\n"
            "0 2 * * * managed\n"
            f"{_MANAGED_END}\n"
        )
        args = self._make_args()
        with patch(
            "tools.cron_installer.read_current_crontab", return_value=existing
        ):
            with patch(
                "tools.cron_installer.write_crontab",
                side_effect=subprocess.CalledProcessError(1, "crontab"),
            ):
                result = cmd_uninstall(args)
        assert result == 1

    def test_returns_one_when_crontab_not_found(self, capsys):
        args = self._make_args()
        with patch(
            "tools.cron_installer.read_current_crontab",
            side_effect=FileNotFoundError("crontab not found"),
        ):
            result = cmd_uninstall(args)
        assert result == 1
        err = capsys.readouterr().err
        assert "ERROR" in err


# ---------------------------------------------------------------------------
# main (CLI)
# ---------------------------------------------------------------------------


class TestMain:
    def test_list_returns_zero(self, tmp_path, template_file):
        result = main(
            ["--repo-root", str(tmp_path), "--template", str(template_file), "list"]
        )
        assert result == 0

    def test_install_dry_run_returns_zero(self, tmp_path, template_file):
        with patch("tools.cron_installer.read_current_crontab", return_value=""):
            result = main(
                [
                    "--repo-root", str(tmp_path),
                    "--template", str(template_file),
                    "install",
                    "--dry-run",
                ]
            )
        assert result == 0

    def test_uninstall_no_block_returns_zero(self, tmp_path, template_file):
        with patch("tools.cron_installer.read_current_crontab", return_value=""):
            result = main(
                [
                    "--repo-root", str(tmp_path),
                    "--template", str(template_file),
                    "uninstall",
                    "--dry-run",
                ]
            )
        assert result == 0

    def test_no_subcommand_exits_with_error(self):
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code != 0

    def test_install_then_uninstall_roundtrip(self, tmp_path, template_file):
        captured_crontab: list[str] = []

        def fake_read():
            return captured_crontab[-1] if captured_crontab else ""

        def fake_write(content):
            captured_crontab.append(content)

        with patch("tools.cron_installer.read_current_crontab", side_effect=fake_read):
            with patch("tools.cron_installer.write_crontab", side_effect=fake_write):
                # Install
                install_result = main(
                    [
                        "--repo-root", str(tmp_path),
                        "--template", str(template_file),
                        "install",
                    ]
                )
                assert install_result == 0
                assert _MANAGED_BEGIN in captured_crontab[-1]

                # Uninstall
                uninstall_result = main(
                    [
                        "--repo-root", str(tmp_path),
                        "--template", str(template_file),
                        "uninstall",
                    ]
                )
                assert uninstall_result == 0
                assert _MANAGED_BEGIN not in captured_crontab[-1]
