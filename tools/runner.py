#!/usr/bin/env python3
"""
tools/runner.py – Central automation script runner for home-automation-scripts.

Usage:
    python3 tools/runner.py list
    python3 tools/runner.py run <task>
    python3 tools/runner.py run <task1> <task2> …

Task Registration:
    Place a Python file in the ``scripts/`` directory that exposes a ``run()``
    callable.  Optionally set a module-level ``DESCRIPTION`` string for use in
    the task listing.

    Example – scripts/my_task.py::

        DESCRIPTION = "Does something useful every night."

        def run():
            print("Hello from my_task!")

    The runner discovers all ``*.py`` files in ``scripts/`` (excluding files
    whose names start with ``_``) that define a ``run`` callable.

Exit codes:
    0  All requested tasks completed successfully (or ``list`` was used).
    1  One or more tasks failed or an unknown task was requested.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

# ---------------------------------------------------------------------------
# Ensure the repository root is on sys.path so that ``tools.*`` imports work
# whether this file is executed directly or imported.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402 – path manipulation above

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SCRIPTS_DIR: Path = _REPO_ROOT / "scripts"
_RUNNER_LOGGER_NAME = "runner"


# ---------------------------------------------------------------------------
# Task discovery
# ---------------------------------------------------------------------------


def discover_tasks(scripts_dir: str | Path | None = None) -> dict[str, ModuleType]:
    """Discover automation tasks from Python files in *scripts_dir*.

    A file is considered a valid task module if it exposes a ``run``
    callable at module level.  Files whose names begin with ``_`` (e.g.
    ``__init__.py``, ``_helpers.py``) are silently skipped.

    .. warning::
        Task scripts are executed as trusted Python code.  Only place files
        you control and have reviewed in the ``scripts/`` directory.

    Args:
        scripts_dir: Directory to scan.  Defaults to ``scripts/`` at the
            repository root.

    Returns:
        An ordered mapping of ``{task_name: module}`` sorted alphabetically
        by task name.  ``task_name`` is the filename stem (without ``.py``).
    """
    target_dir = Path(scripts_dir) if scripts_dir is not None else _SCRIPTS_DIR
    tasks: dict[str, ModuleType] = {}

    if not target_dir.is_dir():
        return tasks

    for script_path in sorted(target_dir.glob("*.py")):
        if script_path.name.startswith("_"):
            continue

        module_name = script_path.stem
        spec = importlib.util.spec_from_file_location(module_name, script_path)
        if spec is None or spec.loader is None:
            continue

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)  # type: ignore[union-attr]
        except Exception:
            # A broken script should not prevent the runner from loading others.
            continue

        if callable(getattr(module, "run", None)):
            tasks[module_name] = module

    return tasks


# ---------------------------------------------------------------------------
# Runner helpers
# ---------------------------------------------------------------------------


def list_tasks(tasks: dict[str, ModuleType]) -> None:
    """Print a formatted table of available tasks to stdout.

    Args:
        tasks: Mapping returned by :func:`discover_tasks`.
    """
    if not tasks:
        print(
            "No tasks found.  Add Python scripts with a run() function to scripts/."
        )
        return

    col_width = max((len(name) for name in tasks), default=4) + 2
    header = f"{'Task':<{col_width}} Description"
    print(header)
    print("-" * max(len(header), 60))
    for name, module in tasks.items():
        description = getattr(module, "DESCRIPTION", "(no description)")
        print(f"{name:<{col_width}} {description}")


def run_task(
    name: str,
    tasks: dict[str, ModuleType],
    logger: "logging.Logger",  # type: ignore[name-defined]  # noqa: F821
) -> bool:
    """Execute a single named task with logging and error handling.

    All exceptions raised by the task's ``run()`` function are caught,
    logged at ERROR level (with a full traceback at DEBUG level), and cause
    this function to return ``False`` so the caller can aggregate failures
    across multiple tasks.

    Args:
        name: Task name to execute.
        tasks: Mapping returned by :func:`discover_tasks`.
        logger: Logger to record progress and errors.

    Returns:
        ``True`` if the task completed without raising an exception,
        ``False`` otherwise.
    """
    if name not in tasks:
        logger.error(
            "Unknown task %r – run 'list' to see available tasks.", name
        )
        return False

    module = tasks[name]
    logger.info("Starting task: %s", name)
    try:
        module.run()
        logger.info("Task completed successfully: %s", name)
        return True
    except Exception as exc:
        logger.error(
            "Task failed: %s – %s: %s",
            name,
            type(exc).__name__,
            exc,
            exc_info=True,
        )
        return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run registered home-automation scripts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    subparsers = parser.add_subparsers(dest="command")
    subparsers.required = True

    subparsers.add_parser("list", help="List all available tasks.")

    run_parser = subparsers.add_parser("run", help="Execute one or more tasks.")
    run_parser.add_argument(
        "tasks",
        nargs="+",
        metavar="TASK",
        help="Task name(s) to run in order.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry-point.

    Args:
        argv: Argument list (defaults to :data:`sys.argv`).

    Returns:
        Exit code: ``0`` on success, ``1`` if any task failed.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    logger = get_logger(_RUNNER_LOGGER_NAME)
    available = discover_tasks()

    if args.command == "list":
        list_tasks(available)
        return 0

    if args.command == "run":
        exit_code = 0
        for task_name in args.tasks:
            if not run_task(task_name, available, logger):
                exit_code = 1
        return exit_code

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
