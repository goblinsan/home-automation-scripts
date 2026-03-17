#!/usr/bin/env python3
"""
tools/registry.py – Tool registry loader for home-automation-scripts.

Loads tool definitions from a YAML registry file and returns the enabled tools
as importable Python modules, ready to be executed by the automation CLI.

Registry file format (configs/tools_registry.yaml)::

    tools:
      - name: github-helper
        description: "List open GitHub issues and project board items"
        script: scripts/github_helper.py
        enabled: true          # optional; defaults to true

Each registered script must expose a ``run()`` callable at module level.
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Repository layout
# ---------------------------------------------------------------------------

_REPO_ROOT: Path = Path(__file__).resolve().parent.parent
_DEFAULT_REGISTRY: Path = _REPO_ROOT / "configs" / "tools_registry.yaml"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ToolEntry:
    """Metadata for a single registered tool as declared in the registry."""

    name: str
    script: str
    description: str = "(no description)"
    enabled: bool = True


# ---------------------------------------------------------------------------
# Registry loading
# ---------------------------------------------------------------------------


def load_registry(registry_path: str | Path | None = None) -> list[ToolEntry]:
    """Load and validate tool entries from the YAML registry file.

    Args:
        registry_path: Path to the registry YAML file.  Defaults to
            ``configs/tools_registry.yaml`` at the repository root.

    Returns:
        A list of :class:`ToolEntry` instances (all entries, including
        disabled ones).

    Raises:
        FileNotFoundError: If the registry file does not exist.
        ValueError: If the registry file is malformed or entries are missing
            required fields.
    """
    path = Path(registry_path) if registry_path is not None else _DEFAULT_REGISTRY
    if not path.is_file():
        raise FileNotFoundError(f"Tool registry not found: {path}")

    try:
        with path.open(encoding="utf-8") as fh:
            data: Any = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        raise ValueError(f"Registry file contains invalid YAML: {path}: {exc}") from exc

    if not isinstance(data, dict) or "tools" not in data:
        raise ValueError(
            f"Registry file must contain a top-level 'tools' list: {path}"
        )

    raw_tools = data["tools"]
    if not isinstance(raw_tools, list):
        raise ValueError(f"'tools' in registry must be a list: {path}")

    entries: list[ToolEntry] = []
    for i, item in enumerate(raw_tools):
        if not isinstance(item, dict):
            raise ValueError(
                f"Registry entry #{i} is not a mapping: {item!r}"
            )
        if "name" not in item:
            raise ValueError(
                f"Registry entry #{i} is missing required field 'name'."
            )
        if "script" not in item:
            raise ValueError(
                f"Registry entry '{item['name']}' is missing required field 'script'."
            )
        entries.append(
            ToolEntry(
                name=str(item["name"]),
                script=str(item["script"]),
                description=str(item.get("description", "(no description)")),
                enabled=bool(item.get("enabled", True)),
            )
        )
    return entries


# ---------------------------------------------------------------------------
# Module discovery
# ---------------------------------------------------------------------------


def discover_registered_tools(
    registry_path: str | Path | None = None,
    repo_root: str | Path | None = None,
) -> dict[str, ModuleType]:
    """Load the registry and import enabled tools as Python modules.

    Only tools with ``enabled: true`` are imported.  Tools whose ``script``
    file is missing, fails to import, or does not expose a ``run()`` callable
    are silently skipped (consistent with :func:`tools.runner.discover_tasks`).

    The registry ``description`` field is set as ``module.DESCRIPTION`` so
    that :func:`tools.runner.list_tasks` can display it without re-reading
    the YAML file.

    Args:
        registry_path: Path to the registry YAML file.
        repo_root: Repository root directory.  Defaults to the parent of the
            ``tools/`` directory.

    Returns:
        An ordered mapping of ``{tool_name: module}`` for all importable
        enabled tools, sorted alphabetically by name.
    """
    root = Path(repo_root) if repo_root is not None else _REPO_ROOT

    try:
        entries = load_registry(registry_path)
    except (FileNotFoundError, ValueError):
        return {}

    tools: dict[str, ModuleType] = {}
    for entry in sorted(entries, key=lambda e: e.name):
        if not entry.enabled:
            continue

        script_path = (root / entry.script).resolve()
        if not script_path.is_file():
            continue

        spec = importlib.util.spec_from_file_location(entry.name, script_path)
        if spec is None or spec.loader is None:
            continue

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)  # type: ignore[union-attr]
        except Exception:
            # A broken script must not prevent other tools from loading.
            continue

        if not callable(getattr(module, "run", None)):
            continue

        # Registry description is authoritative; override the module attribute.
        module.DESCRIPTION = entry.description  # type: ignore[attr-defined]
        tools[entry.name] = module

    return tools


# ---------------------------------------------------------------------------
# CLI (stand-alone validation)
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """Print all entries from the registry to stdout (validation helper).

    Args:
        argv: Argument list (defaults to :data:`sys.argv`).

    Returns:
        ``0`` on success, ``1`` if the registry cannot be loaded.
    """
    import argparse

    parser = argparse.ArgumentParser(
        description="Validate and display the tool registry."
    )
    parser.add_argument(
        "--registry",
        metavar="PATH",
        default=None,
        help="Path to the registry YAML file (default: configs/tools_registry.yaml).",
    )
    args = parser.parse_args(argv)

    try:
        entries = load_registry(args.registry)
    except (FileNotFoundError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not entries:
        print("No tools registered.")
        return 0

    col_width = max(len(e.name) for e in entries) + 2
    header = f"{'Name':<{col_width}} {'Enabled':<8} Script"
    print(header)
    print("-" * max(len(header), 60))
    for entry in entries:
        enabled_str = "yes" if entry.enabled else "no"
        print(f"{entry.name:<{col_width}} {enabled_str:<8} {entry.script}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
