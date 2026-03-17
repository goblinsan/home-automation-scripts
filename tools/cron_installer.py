#!/usr/bin/env python3
"""
tools/cron_installer.py – CLI helper for installing cron job templates.

Usage:
    python3 tools/cron_installer.py list
    python3 tools/cron_installer.py install [--dry-run]
    python3 tools/cron_installer.py uninstall [--dry-run]

Commands:
    list        Show the cron entries that would be installed (after variable
                substitution) without touching the crontab.
    install     Add the managed cron entries to the current user's crontab.
                Re-running install is safe: any existing managed block is
                replaced rather than duplicated.
    uninstall   Remove the managed cron entries from the current user's crontab.
                Other crontab entries are preserved.

Options:
    --dry-run           Print the resulting crontab without making any changes.
    --repo-root PATH    Override the repository root (default: auto-detected as
                        the parent directory of this file).
    --template PATH     Path to the cron template file (default:
                        configs/crontab.example relative to the repo root).

Managed block markers:
    Installed entries are wrapped in the following comment lines so the tool
    can locate and update them reliably:

        # BEGIN home-automation-scripts managed block
        ...
        # END home-automation-scripts managed block

    Do not edit lines within this block manually; use ``install`` to refresh
    or ``uninstall`` to remove.

Exit codes:
    0  Command completed successfully.
    1  An error occurred (template not found, crontab write failed, etc.).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import List

# ---------------------------------------------------------------------------
# Repository layout constants
# ---------------------------------------------------------------------------

_REPO_ROOT: Path = Path(__file__).resolve().parent.parent
_DEFAULT_TEMPLATE: Path = _REPO_ROOT / "configs" / "crontab.example"

# Markers that delimit the block managed by this tool inside the user crontab.
_MANAGED_BEGIN = "# BEGIN home-automation-scripts managed block"
_MANAGED_END = "# END home-automation-scripts managed block"
_MANAGED_WARNING = (
    "# Do not edit this block manually; "
    "run 'python3 tools/cron_installer.py uninstall' to remove it."
)


# ---------------------------------------------------------------------------
# Template helpers
# ---------------------------------------------------------------------------


def _default_python(repo_root: Path) -> str:
    """Return the venv Python path, falling back to :data:`sys.executable`."""
    venv_python = repo_root / ".venv" / "bin" / "python3"
    if venv_python.is_file():
        return str(venv_python)
    return sys.executable


def load_template(template_path: Path, repo_root: Path, python_path: str) -> str:
    """Read *template_path* and substitute ``$REPO_ROOT`` / ``$PYTHON``.

    Args:
        template_path: Path to the cron template file.
        repo_root: Absolute path to the repository root, substituted for
            ``$REPO_ROOT`` in the template.
        python_path: Absolute path to the Python interpreter, substituted for
            ``$PYTHON`` in the template.

    Returns:
        The template text with variables expanded.

    Raises:
        FileNotFoundError: If *template_path* does not exist.
    """
    if not template_path.is_file():
        raise FileNotFoundError(f"Template file not found: {template_path}")

    text = template_path.read_text(encoding="utf-8")
    text = text.replace("$REPO_ROOT", str(repo_root))
    text = text.replace("$PYTHON", python_path)
    return text


def extract_entries(template_text: str) -> List[str]:
    """Return the cron job lines from *template_text*.

    Lines that are blank or begin with ``#`` are considered comments and are
    excluded.  All other lines are treated as cron entries.

    Args:
        template_text: The (already-substituted) template content.

    Returns:
        A list of cron entry strings in the order they appear in the template.
    """
    entries: List[str] = []
    for line in template_text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            entries.append(line)
    return entries


# ---------------------------------------------------------------------------
# Crontab I/O
# ---------------------------------------------------------------------------


def read_current_crontab() -> str:
    """Return the current user's crontab as a string.

    Returns an empty string when the user has no crontab yet (crontab -l exits
    non-zero on most systems in that case).

    Raises:
        FileNotFoundError: If the ``crontab`` binary is not available.
    """
    result = subprocess.run(
        ["crontab", "-l"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return ""
    return result.stdout


def write_crontab(content: str) -> None:
    """Write *content* as the current user's crontab.

    Args:
        content: The full crontab text to install.

    Raises:
        subprocess.CalledProcessError: If ``crontab -`` exits non-zero.
        FileNotFoundError: If the ``crontab`` binary is not available.
    """
    subprocess.run(
        ["crontab", "-"],
        input=content,
        text=True,
        check=True,
    )


# ---------------------------------------------------------------------------
# Managed-block helpers
# ---------------------------------------------------------------------------


def remove_managed_block(crontab: str) -> str:
    """Strip the managed block (if present) from *crontab*.

    Lines between ``_MANAGED_BEGIN`` and ``_MANAGED_END`` (inclusive) are
    removed.  Everything outside the markers is preserved unchanged.

    Args:
        crontab: The full crontab text.

    Returns:
        The crontab text with the managed block removed.
    """
    lines = crontab.splitlines(keepends=True)
    result: List[str] = []
    inside_block = False
    for line in lines:
        stripped = line.rstrip("\n").rstrip("\r")
        if stripped == _MANAGED_BEGIN:
            inside_block = True
        elif stripped == _MANAGED_END:
            inside_block = False
        elif not inside_block:
            result.append(line)
    return "".join(result)


def build_managed_block(entries: List[str]) -> str:
    """Wrap *entries* in the managed block markers.

    Args:
        entries: Cron entry strings to include in the block.

    Returns:
        The complete managed block as a single string (newline-terminated).
    """
    lines = [
        _MANAGED_BEGIN + "\n",
        _MANAGED_WARNING + "\n",
    ]
    for entry in entries:
        lines.append(entry.rstrip("\n") + "\n")
    lines.append(_MANAGED_END + "\n")
    return "".join(lines)


# ---------------------------------------------------------------------------
# Sub-command implementations
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> int:
    """Print the cron entries from the template to stdout."""
    repo_root = Path(args.repo_root) if args.repo_root else _REPO_ROOT
    template_path = Path(args.template) if args.template else _DEFAULT_TEMPLATE
    python_path = _default_python(repo_root)

    try:
        text = load_template(template_path, repo_root, python_path)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    entries = extract_entries(text)
    if not entries:
        print("No cron entries found in the template.")
        return 0

    print(f"Cron entries from {template_path}:\n")
    for entry in entries:
        print(f"  {entry}")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    """Add (or refresh) the managed cron block in the user's crontab."""
    repo_root = Path(args.repo_root) if args.repo_root else _REPO_ROOT
    template_path = Path(args.template) if args.template else _DEFAULT_TEMPLATE
    python_path = _default_python(repo_root)
    dry_run: bool = args.dry_run

    try:
        text = load_template(template_path, repo_root, python_path)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    entries = extract_entries(text)
    if not entries:
        print("No cron entries found in the template. Nothing to install.")
        return 0

    try:
        current = read_current_crontab()
    except FileNotFoundError:
        print(
            "ERROR: 'crontab' binary not found. "
            "Install the cron package and try again.",
            file=sys.stderr,
        )
        return 1

    # Remove any previously installed managed block (idempotent re-install).
    cleaned = remove_managed_block(current)
    managed_block = build_managed_block(entries)

    # Append the managed block, ensuring exactly one trailing newline before it.
    base = cleaned.rstrip("\n")
    new_crontab = (base + "\n" if base else "") + managed_block

    if dry_run:
        print("[dry-run] Would write the following crontab:\n")
        print(new_crontab)
        return 0

    try:
        write_crontab(new_crontab)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"ERROR: Failed to write crontab: {exc}", file=sys.stderr)
        return 1

    print(f"Installed {len(entries)} cron job(s) into the user crontab.")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    """Remove the managed cron block from the user's crontab."""
    dry_run: bool = args.dry_run

    try:
        current = read_current_crontab()
    except FileNotFoundError:
        print(
            "ERROR: 'crontab' binary not found. "
            "Install the cron package and try again.",
            file=sys.stderr,
        )
        return 1

    new_crontab = remove_managed_block(current)

    if new_crontab == current:
        print("No managed cron block found. Nothing to remove.")
        return 0

    if dry_run:
        result_display = new_crontab if new_crontab.strip() else "(empty)"
        print("[dry-run] Would write the following crontab:\n")
        print(result_display)
        return 0

    try:
        write_crontab(new_crontab)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"ERROR: Failed to write crontab: {exc}", file=sys.stderr)
        return 1

    print("Managed cron block removed from the user crontab.")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install or remove predefined cron jobs for home-automation-scripts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Shared options
    parser.add_argument(
        "--repo-root",
        metavar="PATH",
        default=None,
        help=(
            "Override the repository root directory "
            "(default: parent of tools/ directory)."
        ),
    )
    parser.add_argument(
        "--template",
        metavar="PATH",
        default=None,
        help=(
            "Path to the cron template file "
            "(default: configs/crontab.example in the repo root)."
        ),
    )

    subparsers = parser.add_subparsers(dest="command")
    subparsers.required = True

    subparsers.add_parser("list", help="Show cron entries defined in the template.")

    install_parser = subparsers.add_parser(
        "install", help="Add managed cron entries to the user's crontab."
    )
    install_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resulting crontab without making any changes.",
    )

    uninstall_parser = subparsers.add_parser(
        "uninstall", help="Remove managed cron entries from the user's crontab."
    )
    uninstall_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resulting crontab without making any changes.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry-point.

    Args:
        argv: Argument list (defaults to :data:`sys.argv`).

    Returns:
        Exit code: ``0`` on success, ``1`` on error.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "list":
        return cmd_list(args)
    if args.command == "install":
        return cmd_install(args)
    if args.command == "uninstall":
        return cmd_uninstall(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
