#!/usr/bin/env python3
"""
scripts/package_update_notifier.py – Package update notifier.

Checks whether system package updates are available and logs a notification
summary.  Supports ``apt`` (Debian/Ubuntu) and ``dnf``/``yum`` (Fedora/RHEL).

Usage (via automation CLI):
    python3 tools/automation.py run package-update-notifier

Usage (direct):
    python3 scripts/package_update_notifier.py

Environment variables (optional):
    PKG_MANAGER   Force a specific package manager (``apt``, ``dnf``, or
                  ``yum``).  Defaults to auto-detection.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "Notify when system package updates are available"


# ---------------------------------------------------------------------------
# Package manager helpers
# ---------------------------------------------------------------------------


def _detect_package_manager() -> str | None:
    """Return the name of the first available package manager, or ``None``.

    Detection order: ``apt``, ``dnf``, ``yum``.
    """
    for manager in ("apt", "dnf", "yum"):
        if shutil.which(manager) is not None:
            return manager
    return None


def check_apt_updates() -> list[str]:
    """Return a list of upgradable package names using ``apt``.

    Runs ``apt-get -s upgrade`` (simulation mode – no changes are made).

    Returns:
        Package names that would be upgraded.

    Raises:
        RuntimeError: If the ``apt-get`` command fails.
    """
    try:
        result = subprocess.run(
            ["apt-get", "-s", "upgrade"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("apt-get not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("apt-get timed out") from exc

    if result.returncode != 0:
        raise RuntimeError(
            f"apt-get -s upgrade failed (exit {result.returncode}): {result.stderr.strip()}"
        )

    packages: list[str] = []
    for line in result.stdout.splitlines():
        # Lines like: "Inst <package> [<old>] (<new> ...)"
        if line.startswith("Inst "):
            parts = line.split()
            if len(parts) >= 2:
                packages.append(parts[1])
    return packages


def check_dnf_updates() -> list[str]:
    """Return a list of available package updates using ``dnf`` or ``yum``.

    Runs ``dnf check-update`` (or ``yum check-update``) which exits with
    code 100 when updates are available, 0 when none are found.

    Returns:
        Package names that have available updates.

    Raises:
        RuntimeError: If the command fails unexpectedly.
    """
    manager = "dnf" if shutil.which("dnf") else "yum"
    try:
        result = subprocess.run(
            [manager, "check-update", "-q"],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{manager} not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{manager} check-update timed out") from exc

    # exit code 100 = updates available, 0 = up to date, anything else = error
    if result.returncode not in (0, 100):
        raise RuntimeError(
            f"{manager} check-update failed (exit {result.returncode}): "
            f"{result.stderr.strip()}"
        )

    packages: list[str] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith(("Loaded", "Last metadata", "Security:")):
            continue
        parts = line.split()
        if len(parts) >= 2:
            # Lines like: "<name>.<arch>  <version>  <repo>"
            packages.append(parts[0])
    return packages


def get_available_updates(package_manager: str | None = None) -> tuple[str, list[str]]:
    """Detect the package manager and return available updates.

    Args:
        package_manager: Override the auto-detected package manager.  Must be
            one of ``"apt"``, ``"dnf"``, or ``"yum"``.

    Returns:
        A tuple of ``(manager_name, [package, ...])`` where *manager_name* is
        the detected or overridden package manager name.

    Raises:
        RuntimeError: If no supported package manager is found or the update
            check fails.
    """
    manager = package_manager or _detect_package_manager()
    if manager is None:
        raise RuntimeError(
            "No supported package manager found (looked for: apt, dnf, yum)"
        )

    if manager == "apt":
        return "apt", check_apt_updates()
    if manager in ("dnf", "yum"):
        return manager, check_dnf_updates()

    raise RuntimeError(f"Unsupported package manager: {manager!r}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run() -> None:
    """Entry point called by the automation runner.

    Detects the available package manager, checks for updates, and logs a
    summary of any packages that can be upgraded.
    """
    log = get_logger("package-update-notifier")

    override_manager = os.environ.get("PKG_MANAGER") or None

    log.info("Checking for available package updates …")

    try:
        manager, packages = get_available_updates(override_manager)
    except RuntimeError as exc:
        log.error("Package update check failed: %s", exc)
        raise

    if not packages:
        log.info("All packages are up to date (checked with %s).", manager)
        return

    log.info(
        "%d package update(s) available via %s:", len(packages), manager
    )
    for pkg in packages:
        log.info("  %s", pkg)


if __name__ == "__main__":
    run()
