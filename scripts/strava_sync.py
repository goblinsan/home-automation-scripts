#!/usr/bin/env python3
"""
scripts/strava_sync.py – Strava activity sync script.

Fetches recent Strava activities (last 24 hours by default), normalizes
the data, and writes the results to ``data/strava/activities/``.

Usage (via automation CLI):
    python3 tools/automation.py run strava-sync

Usage (direct):
    python3 scripts/strava_sync.py

Usage (via wrapper):
    ./run_strava_sync.sh

Environment variables required (set in .env or the shell):
    STRAVA_CLIENT_ID       OAuth client ID from your Strava API application.
    STRAVA_CLIENT_SECRET   OAuth client secret from your Strava API application.
    STRAVA_REFRESH_TOKEN   Long-lived refresh token obtained via the OAuth flow.

Environment variables optional:
    STRAVA_LOOKBACK_DAYS   Number of days of activities to fetch (default: 1).
    STRAVA_OUTPUT_DIR      Directory to write JSON output files.
                           Defaults to data/strava/activities/ in the repo root.
    STRAVA_MAX_RETRIES     Number of API call retries on transient errors (default: 3).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure repo root is on sys.path so that ``tools.*`` imports work.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.env_loader import require_env  # noqa: E402
from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "Fetch recent Strava activities and store them locally as normalized JSON"

_REQUIRED_ENV_VARS = ("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN")
_STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
_STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities"
_DEFAULT_LOOKBACK_DAYS = 1
_DEFAULT_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE = 2  # seconds


# ---------------------------------------------------------------------------
# OAuth helpers
# ---------------------------------------------------------------------------


def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    """Exchange a refresh token for a short-lived access token.

    Args:
        client_id: Strava application client ID.
        client_secret: Strava application client secret.
        refresh_token: Long-lived refresh token.

    Returns:
        A fresh OAuth access token string.

    Raises:
        RuntimeError: If the token exchange request fails.
    """
    payload = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        _STRAVA_TOKEN_URL,
        data=payload,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Token refresh failed ({exc.code} {exc.reason}): {body}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"Token refresh request failed: {exc}") from exc

    access_token = data.get("access_token")
    if not access_token:
        raise RuntimeError(
            "Token refresh response did not contain 'access_token'. "
            f"Response keys: {list(data.keys())}"
        )
    return access_token


# ---------------------------------------------------------------------------
# Strava API helpers
# ---------------------------------------------------------------------------


def _strava_get(
    url: str, access_token: str, max_retries: int = _DEFAULT_MAX_RETRIES
) -> list | dict:
    """Perform an authenticated GET request against the Strava API.

    Retries on 5xx errors with exponential back-off.

    Args:
        url: Full URL to request.
        access_token: Valid Strava access token.
        max_retries: Maximum number of retry attempts on transient errors.

    Returns:
        Parsed JSON response (list or dict).

    Raises:
        RuntimeError: If all retries are exhausted or a non-retryable error occurs.
    """
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise RuntimeError(
                    "Strava API rate limit exceeded (HTTP 429). "
                    "Try again later or reduce STRAVA_LOOKBACK_DAYS."
                ) from exc
            if exc.code >= 500 and attempt < max_retries:
                wait = _RETRY_BACKOFF_BASE**attempt
                time.sleep(wait)
                last_exc = exc
                continue
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Strava API request failed ({exc.code} {exc.reason}): {body}"
            ) from exc
        except Exception as exc:
            if attempt < max_retries:
                wait = _RETRY_BACKOFF_BASE**attempt
                time.sleep(wait)
                last_exc = exc
                continue
            raise RuntimeError(f"Strava API request failed: {exc}") from exc
    raise RuntimeError(
        f"Strava API request failed after {max_retries} retries: {last_exc}"
    )


def fetch_activities(
    access_token: str,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    max_retries: int = _DEFAULT_MAX_RETRIES,
) -> list[dict]:
    """Fetch activities from the Strava API since ``lookback_days`` ago.

    Args:
        access_token: Valid Strava access token.
        lookback_days: Fetch activities from the last N days.
        max_retries: Maximum number of retries on transient errors.

    Returns:
        A list of raw activity dicts from the Strava API.

    Raises:
        RuntimeError: If the API request fails.
    """
    after_ts = int(
        (datetime.now(tz=timezone.utc) - timedelta(days=lookback_days)).timestamp()
    )
    params = urllib.parse.urlencode({"after": after_ts, "per_page": 200})
    url = f"{_STRAVA_ACTIVITIES_URL}?{params}"
    result = _strava_get(url, access_token, max_retries=max_retries)
    if not isinstance(result, list):
        raise RuntimeError(
            f"Unexpected response type from Strava activities API: {type(result)}"
        )
    return result


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def normalize_activity(raw: dict) -> dict:
    """Extract and normalize fields of interest from a raw Strava activity.

    Does not include any OAuth tokens or secrets.

    Args:
        raw: Raw activity dict as returned by the Strava API.

    Returns:
        A normalized dict with a consistent set of keys.
    """
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "type": raw.get("type"),
        "sport_type": raw.get("sport_type"),
        "start_date": raw.get("start_date"),
        "start_date_local": raw.get("start_date_local"),
        "distance_m": raw.get("distance"),
        "moving_time_s": raw.get("moving_time"),
        "elapsed_time_s": raw.get("elapsed_time"),
        "elevation_gain_m": raw.get("total_elevation_gain"),
        "average_speed_mps": raw.get("average_speed"),
        "max_speed_mps": raw.get("max_speed"),
        "average_heartrate": raw.get("average_heartrate"),
        "max_heartrate": raw.get("max_heartrate"),
        "calories": raw.get("calories"),
        "kudos_count": raw.get("kudos_count"),
        "achievement_count": raw.get("achievement_count"),
        "map_summary_polyline": (raw.get("map") or {}).get("summary_polyline"),
    }


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def write_output(activities: list[dict], output_dir: Path) -> None:
    """Write normalized activities to the output directory.

    Creates ``latest.json`` (atomically, to avoid corruption on failure) and a
    timestamped snapshot file.  Creates the output directory if it does not
    already exist.

    Args:
        activities: List of normalized activity dicts.
        output_dir: Directory in which to write JSON output files.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    snapshot = {
        "fetched_at": datetime.now(tz=timezone.utc).isoformat(),
        "activity_count": len(activities),
        "activities": activities,
    }
    content = json.dumps(snapshot, indent=2, ensure_ascii=False)

    # Write latest.json atomically via a temp file + rename.
    latest_path = output_dir / "latest.json"
    tmp_path = output_dir / "latest.json.tmp"
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(latest_path)

    # Write a timestamped snapshot for historical reference.
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    timestamped_path = output_dir / f"activities_{ts}.json"
    timestamped_path.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run() -> None:
    """Entry point called by the automation runner or invoked directly.

    Loads required Strava credentials from the environment, refreshes the
    OAuth access token, fetches recent activities, normalizes the data, and
    writes the results to the configured output directory.
    """
    log = get_logger("strava-sync")

    try:
        env = require_env(_REQUIRED_ENV_VARS)
    except RuntimeError as exc:
        log.error("Missing environment variables: %s", exc)
        raise

    lookback_days = int(os.environ.get("STRAVA_LOOKBACK_DAYS", _DEFAULT_LOOKBACK_DAYS))
    max_retries = int(os.environ.get("STRAVA_MAX_RETRIES", _DEFAULT_MAX_RETRIES))

    default_output_dir = _REPO_ROOT / "data" / "strava" / "activities"
    output_dir = Path(os.environ.get("STRAVA_OUTPUT_DIR", str(default_output_dir)))

    log.info("=== Strava Sync started ===")
    log.info("Lookback: %d day(s)  |  Output: %s", lookback_days, output_dir)

    log.info("Refreshing Strava access token …")
    try:
        access_token = refresh_access_token(
            client_id=env["STRAVA_CLIENT_ID"],
            client_secret=env["STRAVA_CLIENT_SECRET"],
            refresh_token=env["STRAVA_REFRESH_TOKEN"],
        )
    except RuntimeError as exc:
        log.error("Failed to refresh access token: %s", exc)
        raise

    log.info("Fetching activities for the last %d day(s) …", lookback_days)
    try:
        raw_activities = fetch_activities(
            access_token=access_token,
            lookback_days=lookback_days,
            max_retries=max_retries,
        )
    except RuntimeError as exc:
        log.error("Failed to fetch activities: %s", exc)
        raise

    log.info("Fetched %d activity/activities.", len(raw_activities))

    normalized = [normalize_activity(a) for a in raw_activities]

    write_output(normalized, output_dir)
    log.info("Wrote %d activity/activities to %s.", len(normalized), output_dir)
    log.info("=== Strava Sync complete ===")


if __name__ == "__main__":
    run()
