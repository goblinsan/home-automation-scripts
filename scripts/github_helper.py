#!/usr/bin/env python3
"""
scripts/github_helper.py – GitHub issue and project board helper.

Usage (via automation CLI):
    python3 tools/automation.py run github-helper

Usage (direct):
    python3 scripts/github_helper.py

Environment variables required (set in .env or the shell):
    GITHUB_TOKEN   Personal access token with ``repo`` scope.
    GITHUB_OWNER   GitHub username or organisation that owns the repository.
    GITHUB_REPO    Repository name (without the owner prefix).
"""

from __future__ import annotations

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Ensure repo root is on sys.path so that ``tools.*`` imports work.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.env_loader import require_env  # noqa: E402
from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "List open GitHub issues and project board items for a repository"

_REQUIRED_ENV_VARS = ("GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO")
_GITHUB_API_BASE = "https://api.github.com"


# ---------------------------------------------------------------------------
# GitHub API helpers
# ---------------------------------------------------------------------------


def _github_get(path: str, token: str) -> list | dict:
    """Perform an authenticated GET request against the GitHub REST API.

    Args:
        path: API path starting with ``/`` (e.g. ``/repos/owner/repo/issues``).
        token: GitHub personal access token.

    Returns:
        The parsed JSON response (list or dict).

    Raises:
        RuntimeError: If the HTTP request fails or the response is not valid JSON.
    """
    url = f"{_GITHUB_API_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"GitHub API request failed ({exc.code}): {exc.reason} – {url}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"GitHub API request failed: {exc} – {url}") from exc


def list_open_issues(token: str, owner: str, repo: str) -> list[dict]:
    """Return open issues for *owner*/*repo* (up to 100 per request).

    Args:
        token: GitHub personal access token.
        owner: Repository owner (user or organisation).
        repo: Repository name.

    Returns:
        A list of issue dicts as returned by the GitHub REST API.

    Raises:
        RuntimeError: If the API request fails.
    """
    path = f"/repos/{owner}/{repo}/issues?state=open&per_page=100"
    result = _github_get(path, token)
    if not isinstance(result, list):
        raise RuntimeError(
            f"Unexpected response type from GitHub issues API: {type(result)}"
        )
    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run() -> None:
    """Entry point called by the automation runner.

    Reads required environment variables, fetches open issues from the
    configured GitHub repository, and logs each issue's number and title.
    """
    log = get_logger("github-helper")

    try:
        env = require_env(_REQUIRED_ENV_VARS)
    except RuntimeError as exc:
        log.error("Missing environment variables: %s", exc)
        raise

    token = env["GITHUB_TOKEN"]
    owner = env["GITHUB_OWNER"]
    repo = env["GITHUB_REPO"]

    log.info("Fetching open issues for %s/%s …", owner, repo)
    issues = list_open_issues(token, owner, repo)

    if not issues:
        log.info("No open issues found.")
        return

    log.info("Open issues (%d):", len(issues))
    for issue in issues:
        log.info("  #%s  %s", issue.get("number"), issue.get("title"))


if __name__ == "__main__":
    run()
