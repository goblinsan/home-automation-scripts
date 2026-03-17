"""Tests for tools/registry.py."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

import pytest

# Ensure repo root is on sys.path before importing project modules.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.registry import ToolEntry, load_registry, discover_registered_tools


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_registry(tmp_path: Path, content: str) -> Path:
    """Write *content* to a temporary YAML file and return its path."""
    reg = tmp_path / "tools_registry.yaml"
    reg.write_text(content, encoding="utf-8")
    return reg


def _write_script(directory: Path, name: str, has_run: bool = True) -> Path:
    """Create a minimal task script in *directory* and return its path."""
    body = f"DESCRIPTION = '{name} tool'\ndef run():\n    pass\n" if has_run else "x = 1\n"
    p = directory / f"{name}.py"
    p.write_text(body, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# load_registry
# ---------------------------------------------------------------------------


class TestLoadRegistry:
    def test_returns_list_of_tool_entries(self, tmp_path):
        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: my-tool\n    script: scripts/my_tool.py\n",
        )
        entries = load_registry(reg)
        assert len(entries) == 1
        assert isinstance(entries[0], ToolEntry)
        assert entries[0].name == "my-tool"
        assert entries[0].script == "scripts/my_tool.py"

    def test_defaults_description_and_enabled(self, tmp_path):
        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: t\n    script: scripts/t.py\n",
        )
        entry = load_registry(reg)[0]
        assert entry.description == "(no description)"
        assert entry.enabled is True

    def test_reads_description_and_enabled_false(self, tmp_path):
        reg = _write_registry(
            tmp_path,
            (
                "tools:\n"
                "  - name: t\n"
                "    script: scripts/t.py\n"
                "    description: My desc\n"
                "    enabled: false\n"
            ),
        )
        entry = load_registry(reg)[0]
        assert entry.description == "My desc"
        assert entry.enabled is False

    def test_file_not_found_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_registry(tmp_path / "nonexistent.yaml")

    def test_missing_tools_key_raises_value_error(self, tmp_path):
        reg = _write_registry(tmp_path, "other: []\n")
        with pytest.raises(ValueError, match="top-level 'tools'"):
            load_registry(reg)

    def test_tools_not_a_list_raises_value_error(self, tmp_path):
        reg = _write_registry(tmp_path, "tools: not-a-list\n")
        with pytest.raises(ValueError, match="must be a list"):
            load_registry(reg)

    def test_entry_not_a_dict_raises_value_error(self, tmp_path):
        reg = _write_registry(tmp_path, "tools:\n  - just-a-string\n")
        with pytest.raises(ValueError, match="not a mapping"):
            load_registry(reg)

    def test_entry_missing_name_raises_value_error(self, tmp_path):
        reg = _write_registry(
            tmp_path, "tools:\n  - script: scripts/t.py\n"
        )
        with pytest.raises(ValueError, match="missing required field 'name'"):
            load_registry(reg)

    def test_entry_missing_script_raises_value_error(self, tmp_path):
        reg = _write_registry(tmp_path, "tools:\n  - name: t\n")
        with pytest.raises(ValueError, match="missing required field 'script'"):
            load_registry(reg)

    def test_multiple_entries_returned(self, tmp_path):
        reg = _write_registry(
            tmp_path,
            (
                "tools:\n"
                "  - name: alpha\n    script: scripts/alpha.py\n"
                "  - name: beta\n    script: scripts/beta.py\n"
            ),
        )
        entries = load_registry(reg)
        assert len(entries) == 2
        assert {e.name for e in entries} == {"alpha", "beta"}


# ---------------------------------------------------------------------------
# discover_registered_tools
# ---------------------------------------------------------------------------


class TestDiscoverRegisteredTools:
    def test_returns_module_for_valid_tool(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "alpha")

        reg = _write_registry(
            tmp_path,
            f"tools:\n  - name: alpha\n    script: scripts/alpha.py\n",
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert "alpha" in tools
        assert callable(getattr(tools["alpha"], "run", None))

    def test_registry_description_overrides_module_description(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "alpha")  # module DESCRIPTION = 'alpha tool'

        reg = _write_registry(
            tmp_path,
            (
                "tools:\n"
                "  - name: alpha\n"
                "    script: scripts/alpha.py\n"
                "    description: Registry description\n"
            ),
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert tools["alpha"].DESCRIPTION == "Registry description"

    def test_skips_disabled_tools(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "disabled")

        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: disabled\n    script: scripts/disabled.py\n    enabled: false\n",
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert "disabled" not in tools

    def test_skips_missing_script_files(self, tmp_path):
        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: ghost\n    script: scripts/ghost.py\n",
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert "ghost" not in tools

    def test_skips_scripts_without_run(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        _write_script(scripts_dir, "norun", has_run=False)

        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: norun\n    script: scripts/norun.py\n",
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert "norun" not in tools

    def test_skips_broken_scripts(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        broken = scripts_dir / "broken.py"
        broken.write_text("def run():\n    pass\nimport this that\n")

        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: broken\n    script: scripts/broken.py\n",
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert "broken" not in tools

    def test_returns_sorted_by_name(self, tmp_path):
        scripts_dir = tmp_path / "scripts"
        scripts_dir.mkdir()
        for name in ("zebra", "apple", "mango"):
            _write_script(scripts_dir, name)

        reg = _write_registry(
            tmp_path,
            (
                "tools:\n"
                "  - name: zebra\n    script: scripts/zebra.py\n"
                "  - name: apple\n    script: scripts/apple.py\n"
                "  - name: mango\n    script: scripts/mango.py\n"
            ),
        )
        tools = discover_registered_tools(registry_path=reg, repo_root=tmp_path)
        assert list(tools.keys()) == ["apple", "mango", "zebra"]

    def test_missing_registry_returns_empty_dict(self, tmp_path):
        tools = discover_registered_tools(
            registry_path=tmp_path / "missing.yaml",
            repo_root=tmp_path,
        )
        assert tools == {}

    def test_malformed_registry_returns_empty_dict(self, tmp_path):
        bad_reg = tmp_path / "bad.yaml"
        bad_reg.write_text("not: valid: yaml: structure\n  - oops\n")
        tools = discover_registered_tools(
            registry_path=bad_reg, repo_root=tmp_path
        )
        assert tools == {}


# ---------------------------------------------------------------------------
# registry.main (CLI)
# ---------------------------------------------------------------------------


class TestRegistryMain:
    def test_valid_registry_returns_zero(self, tmp_path, capsys):
        reg = _write_registry(
            tmp_path,
            "tools:\n  - name: t\n    script: scripts/t.py\n",
        )
        from tools.registry import main

        assert main(["--registry", str(reg)]) == 0
        out = capsys.readouterr().out
        assert "t" in out

    def test_missing_registry_returns_one(self, tmp_path, capsys):
        from tools.registry import main

        assert main(["--registry", str(tmp_path / "nope.yaml")]) == 1

    def test_empty_registry_prints_no_tools(self, tmp_path, capsys):
        reg = _write_registry(tmp_path, "tools: []\n")
        from tools.registry import main

        assert main(["--registry", str(reg)]) == 0
        out = capsys.readouterr().out
        assert "No tools registered" in out
