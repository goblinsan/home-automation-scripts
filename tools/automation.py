#!/usr/bin/env python3
"""
tools/automation.py – Automation CLI for home-automation-scripts.

Usage:
    python3 tools/automation.py list
    python3 tools/automation.py run <tool>
    python3 tools/automation.py run <tool1> <tool2> …

Examples:
    automation list
    automation run github-helper

Tools are discovered from the registry file (configs/tools_registry.yaml).
Each registered tool must be a Python script that exposes a ``run()`` callable.

Exit codes:
    0  All requested tools completed successfully (or ``list`` was used).
    1  One or more tools failed or an unknown tool was requested.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure the repository root is on sys.path so that ``tools.*`` imports work
# whether this file is executed directly or imported.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402
from tools.registry import discover_registered_tools  # noqa: E402
from tools.runner import list_tasks, run_task  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_AUTOMATION_LOGGER_NAME = "automation"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run registered home-automation tools.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.required = True

    subparsers.add_parser("list", help="List all available tools.")

    run_parser = subparsers.add_parser("run", help="Execute one or more tools.")
    run_parser.add_argument(
        "tools",
        nargs="+",
        metavar="TOOL",
        help="Tool name(s) to run in order.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry-point.

    Args:
        argv: Argument list (defaults to :data:`sys.argv`).

    Returns:
        Exit code: ``0`` on success, ``1`` if any tool failed.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    logger = get_logger(_AUTOMATION_LOGGER_NAME)
    available = discover_registered_tools()

    if args.command == "list":
        list_tasks(available)
        return 0

    if args.command == "run":
        exit_code = 0
        for tool_name in args.tools:
            if not run_task(tool_name, available, logger):
                exit_code = 1
        return exit_code

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
