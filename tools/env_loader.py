#!/usr/bin/env python3
"""
tools/env_loader.py – Secure environment variable loader for home-automation-scripts.

Usage (import into any project script):
    from tools.env_loader import load_env, require_env

Usage (command-line validation):
    python3 tools/env_loader.py [--env-file /path/to/.env] VAR1 VAR2 ...

What it does:
    1. Locates and loads a .env file using python-dotenv (never commits secrets).
    2. Validates that every required variable is present and non-empty.
    3. Raises a clear RuntimeError (or exits with a non-zero code on the CLI)
       when a required variable is missing so problems are caught early.

Security notes:
    - Variables are loaded into os.environ at runtime only; nothing is written
      to disk or printed unless you explicitly call print().
    - The .env file itself must live outside the repository (or in secrets/) and
      is permanently gitignored.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Iterable

try:
    from dotenv import load_dotenv
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "python-dotenv is required. Run: pip install python-dotenv"
    ) from exc


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def load_env(env_file: str | Path | None = None) -> Path:
    """Load a .env file into the current process environment.

    Search order (first match wins):
      1. The explicit *env_file* argument (if given).
      2. A ``.env`` file in the repository root (parent of this file's directory).
      3. A ``.env`` file in the current working directory.

    Args:
        env_file: Optional explicit path to a ``.env`` file.

    Returns:
        The resolved path that was loaded (may not exist if no file was found,
        but existing environment variables are still honoured).

    Raises:
        FileNotFoundError: If *env_file* was specified explicitly but does not
            exist on disk.
    """
    if env_file is not None:
        resolved = Path(env_file).expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(
                f"Specified env file not found: {resolved}"
            )
        load_dotenv(dotenv_path=resolved, override=False)
        return resolved

    # Auto-discover: repo root first, then cwd
    repo_root = Path(__file__).resolve().parent.parent
    for candidate in (repo_root / ".env", Path.cwd() / ".env"):
        if candidate.is_file():
            load_dotenv(dotenv_path=candidate, override=False)
            return candidate

    # No file found – existing environment variables are still usable.
    return Path(".env")


def require_env(variables: Iterable[str], env_file: str | Path | None = None) -> dict[str, str]:
    """Load the .env file and assert that every listed variable is set.

    Args:
        variables: Names of the environment variables that must be present and
            non-empty after loading the .env file.
        env_file: Passed directly to :func:`load_env`.

    Returns:
        A mapping of ``{variable_name: value}`` for all requested variables.

    Raises:
        RuntimeError: If one or more required variables are missing or empty.
    """
    load_env(env_file)

    missing: list[str] = []
    values: dict[str, str] = {}
    for var in variables:
        val = os.environ.get(var, "").strip()
        if not val:
            missing.append(var)
        else:
            values[var] = val

    if missing:
        raise RuntimeError(
            "The following required environment variables are not set:\n"
            + "\n".join(f"  {v}" for v in missing)
            + "\n\nCopy .env.example to .env and fill in the missing values."
        )

    return values


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate that the specified environment variables are present. "
            "Exits with code 0 if all variables are set, non-zero otherwise."
        )
    )
    parser.add_argument(
        "--env-file",
        metavar="PATH",
        default=None,
        help="Path to the .env file to load (default: auto-discover).",
    )
    parser.add_argument(
        "variables",
        nargs="*",
        metavar="VAR",
        help="Names of environment variables to validate.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if not args.variables:
        parser.print_help()
        return 0

    try:
        values = require_env(args.variables, env_file=args.env_file)
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    for var, val in values.items():
        # Show only that the variable is set; never print the actual secret.
        print(f"  {var}: {'*' * min(len(val), 8)} (set)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
