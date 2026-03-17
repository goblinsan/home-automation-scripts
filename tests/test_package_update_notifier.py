"""Tests for scripts/package_update_notifier.py."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.package_update_notifier import (
    _detect_package_manager,
    check_apt_updates,
    check_dnf_updates,
    get_available_updates,
    run,
    DESCRIPTION,
)


# ---------------------------------------------------------------------------
# _detect_package_manager
# ---------------------------------------------------------------------------


class TestDetectPackageManager:
    def test_returns_apt_when_available(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/apt" if name == "apt" else None,
        )
        assert _detect_package_manager() == "apt"

    def test_returns_dnf_when_apt_unavailable(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/dnf" if name == "dnf" else None,
        )
        assert _detect_package_manager() == "dnf"

    def test_returns_yum_as_fallback(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/yum" if name == "yum" else None,
        )
        assert _detect_package_manager() == "yum"

    def test_returns_none_when_none_available(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: None,
        )
        assert _detect_package_manager() is None


# ---------------------------------------------------------------------------
# check_apt_updates
# ---------------------------------------------------------------------------


class TestCheckAptUpdates:
    def _make_apt_output(self, packages: list[str]) -> str:
        lines = []
        for pkg in packages:
            lines.append(f"Inst {pkg} [1.0] (2.0 repo)")
        return "\n".join(lines)

    def test_parses_upgradable_packages(self, monkeypatch):
        output = self._make_apt_output(["bash", "curl", "openssl"])
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout=output, stderr=""),
        )
        packages = check_apt_updates()
        assert packages == ["bash", "curl", "openssl"]

    def test_returns_empty_when_no_updates(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout="", stderr=""),
        )
        assert check_apt_updates() == []

    def test_raises_on_nonzero_exit(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=1, stdout="", stderr="error text"),
        )
        with pytest.raises(RuntimeError, match="apt-get"):
            check_apt_updates()

    def test_raises_when_apt_not_found(self, monkeypatch):
        def _raise(*a, **kw):
            raise FileNotFoundError

        monkeypatch.setattr("scripts.package_update_notifier.subprocess.run", _raise)
        with pytest.raises(RuntimeError, match="apt-get not found"):
            check_apt_updates()

    def test_raises_on_timeout(self, monkeypatch):
        def _timeout(*a, **kw):
            raise subprocess.TimeoutExpired(cmd="apt-get", timeout=60)

        monkeypatch.setattr("scripts.package_update_notifier.subprocess.run", _timeout)
        with pytest.raises(RuntimeError, match="timed out"):
            check_apt_updates()


# ---------------------------------------------------------------------------
# check_dnf_updates
# ---------------------------------------------------------------------------


class TestCheckDnfUpdates:
    def _make_dnf_output(self, packages: list[str]) -> str:
        lines = []
        for pkg in packages:
            lines.append(f"{pkg}.x86_64  2.0  updates")
        return "\n".join(lines)

    def test_parses_upgradable_packages(self, monkeypatch):
        output = self._make_dnf_output(["kernel", "glibc"])
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/dnf" if name == "dnf" else None,
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=100, stdout=output, stderr=""),
        )
        packages = check_dnf_updates()
        assert packages == ["kernel.x86_64", "glibc.x86_64"]

    def test_returns_empty_when_up_to_date(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/dnf" if name == "dnf" else None,
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout="", stderr=""),
        )
        assert check_dnf_updates() == []

    def test_raises_on_unexpected_exit_code(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/dnf" if name == "dnf" else None,
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.subprocess.run",
            lambda *a, **kw: MagicMock(returncode=2, stdout="", stderr="err"),
        )
        with pytest.raises(RuntimeError):
            check_dnf_updates()

    def test_raises_on_timeout(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.shutil.which",
            lambda name: "/usr/bin/dnf" if name == "dnf" else None,
        )

        def _timeout(*a, **kw):
            raise subprocess.TimeoutExpired(cmd="dnf", timeout=120)

        monkeypatch.setattr("scripts.package_update_notifier.subprocess.run", _timeout)
        with pytest.raises(RuntimeError, match="timed out"):
            check_dnf_updates()


# ---------------------------------------------------------------------------
# get_available_updates
# ---------------------------------------------------------------------------


class TestGetAvailableUpdates:
    def test_uses_apt_when_specified(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.check_apt_updates",
            lambda: ["pkg-a"],
        )
        manager, packages = get_available_updates("apt")
        assert manager == "apt"
        assert packages == ["pkg-a"]

    def test_uses_dnf_when_specified(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.check_dnf_updates",
            lambda: ["pkg-b"],
        )
        manager, packages = get_available_updates("dnf")
        assert manager == "dnf"
        assert packages == ["pkg-b"]

    def test_uses_yum_when_specified(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier.check_dnf_updates",
            lambda: ["pkg-c"],
        )
        manager, packages = get_available_updates("yum")
        assert manager == "yum"
        assert packages == ["pkg-c"]

    def test_raises_for_unsupported_manager(self):
        with pytest.raises(RuntimeError, match="Unsupported"):
            get_available_updates("homebrew")

    def test_raises_when_no_manager_found(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier._detect_package_manager",
            lambda: None,
        )
        with pytest.raises(RuntimeError, match="No supported package manager"):
            get_available_updates()

    def test_auto_detects_manager(self, monkeypatch):
        monkeypatch.setattr(
            "scripts.package_update_notifier._detect_package_manager",
            lambda: "apt",
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.check_apt_updates",
            lambda: [],
        )
        manager, packages = get_available_updates()
        assert manager == "apt"
        assert packages == []


# ---------------------------------------------------------------------------
# run()
# ---------------------------------------------------------------------------


class TestPackageUpdateNotifierRun:
    def _null_logger(self, name: str):
        import logging
        log = logging.getLogger(name)
        log.handlers.clear()
        log.addHandler(logging.NullHandler())
        return log

    def test_run_logs_updates(self, monkeypatch):
        import logging
        records: list[logging.LogRecord] = []

        class CapturingHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        log = logging.getLogger("_test_pkg_run_updates")
        log.handlers.clear()
        log.addHandler(CapturingHandler())
        log.setLevel(logging.DEBUG)

        monkeypatch.setattr(
            "scripts.package_update_notifier.get_logger", lambda *a, **kw: log
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.get_available_updates",
            lambda *a, **kw: ("apt", ["bash", "curl"]),
        )
        run()

        messages = [r.getMessage() for r in records]
        assert any("bash" in m for m in messages)
        assert any("curl" in m for m in messages)

    def test_run_logs_up_to_date(self, monkeypatch):
        import logging
        records: list[logging.LogRecord] = []

        class CapturingHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        log = logging.getLogger("_test_pkg_run_uptodate")
        log.handlers.clear()
        log.addHandler(CapturingHandler())
        log.setLevel(logging.DEBUG)

        monkeypatch.setattr(
            "scripts.package_update_notifier.get_logger", lambda *a, **kw: log
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.get_available_updates",
            lambda *a, **kw: ("apt", []),
        )
        run()

        messages = [r.getMessage() for r in records]
        assert any("up to date" in m for m in messages)

    def test_run_raises_on_check_failure(self, monkeypatch):
        import logging
        log = self._null_logger("_test_pkg_run_fail")
        monkeypatch.setattr(
            "scripts.package_update_notifier.get_logger", lambda *a, **kw: log
        )
        monkeypatch.setattr(
            "scripts.package_update_notifier.get_available_updates",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("no manager")),
        )
        with pytest.raises(RuntimeError, match="no manager"):
            run()

    def test_run_uses_env_pkg_manager(self, monkeypatch):
        import logging
        log = self._null_logger("_test_pkg_run_env")
        monkeypatch.setattr(
            "scripts.package_update_notifier.get_logger", lambda *a, **kw: log
        )

        captured: list[str | None] = []

        def fake_updates(manager=None):
            captured.append(manager)
            return ("apt", [])

        monkeypatch.setattr(
            "scripts.package_update_notifier.get_available_updates", fake_updates
        )
        monkeypatch.setenv("PKG_MANAGER", "apt")
        run()
        assert captured == ["apt"]

    def test_description_is_set(self):
        assert isinstance(DESCRIPTION, str)
        assert len(DESCRIPTION) > 0
