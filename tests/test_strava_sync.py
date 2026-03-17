"""Tests for scripts/strava_sync.py."""

from __future__ import annotations

import json
import sys
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.strava_sync import (
    DESCRIPTION,
    _DEFAULT_LOOKBACK_DAYS,
    _DEFAULT_MAX_RETRIES,
    _STRAVA_ACTIVITIES_URL,
    _STRAVA_TOKEN_URL,
    fetch_activities,
    normalize_activity,
    refresh_access_token,
    run,
    write_output,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_http_response(body: dict | list, status: int = 200):
    """Return a mock object that mimics urllib's response context manager."""
    data = json.dumps(body).encode("utf-8")
    mock_resp = MagicMock()
    mock_resp.read.return_value = data
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


def _make_http_error(code: int, reason: str = "Error", body: str = "") -> urllib.error.HTTPError:
    fp = BytesIO(body.encode("utf-8"))
    return urllib.error.HTTPError(url="http://example.com", code=code, msg=reason, hdrs={}, fp=fp)


# ---------------------------------------------------------------------------
# refresh_access_token
# ---------------------------------------------------------------------------


class TestRefreshAccessToken:
    def test_returns_access_token_on_success(self):
        mock_resp = _make_http_response({"access_token": "tok_abc123"})
        with patch("urllib.request.urlopen", return_value=mock_resp):
            token = refresh_access_token("cid", "csec", "reftok")
        assert token == "tok_abc123"

    def test_raises_on_http_error(self):
        err = _make_http_error(401, "Unauthorized", '{"message":"Authorization Error"}')
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="Token refresh failed"):
                refresh_access_token("bad", "bad", "bad")

    def test_raises_when_access_token_missing_from_response(self):
        mock_resp = _make_http_response({"token_type": "Bearer"})
        with patch("urllib.request.urlopen", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="access_token"):
                refresh_access_token("cid", "csec", "reftok")

    def test_raises_on_generic_exception(self):
        with patch("urllib.request.urlopen", side_effect=OSError("network failure")):
            with pytest.raises(RuntimeError, match="Token refresh request failed"):
                refresh_access_token("cid", "csec", "reftok")


# ---------------------------------------------------------------------------
# fetch_activities
# ---------------------------------------------------------------------------


class TestFetchActivities:
    def test_returns_list_of_activities(self):
        activities = [{"id": 1, "name": "Run"}, {"id": 2, "name": "Ride"}]
        mock_resp = _make_http_response(activities)
        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = fetch_activities("tok", lookback_days=1, max_retries=0)
        assert result == activities

    def test_raises_on_rate_limit(self):
        err = _make_http_error(429, "Too Many Requests")
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="rate limit"):
                fetch_activities("tok", lookback_days=1, max_retries=0)

    def test_raises_after_retries_exhausted(self):
        err = _make_http_error(503, "Service Unavailable")
        with patch("urllib.request.urlopen", side_effect=err), \
             patch("time.sleep"):  # skip backoff delays in tests
            with pytest.raises(RuntimeError):
                fetch_activities("tok", lookback_days=1, max_retries=2)

    def test_retries_on_server_error_then_succeeds(self):
        server_err = _make_http_error(503, "Service Unavailable")
        activities = [{"id": 1, "name": "Run"}]
        success_resp = _make_http_response(activities)
        side_effects = [server_err, success_resp]

        with patch("urllib.request.urlopen", side_effect=side_effects), \
             patch("time.sleep"):
            result = fetch_activities("tok", lookback_days=1, max_retries=2)
        assert result == activities

    def test_raises_when_response_is_not_list(self):
        mock_resp = _make_http_response({"error": "unexpected"})
        with patch("urllib.request.urlopen", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="Unexpected response type"):
                fetch_activities("tok", lookback_days=1, max_retries=0)

    def test_raises_on_generic_network_error_after_retries(self):
        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")), \
             patch("time.sleep"):
            with pytest.raises(RuntimeError):
                fetch_activities("tok", lookback_days=1, max_retries=1)


# ---------------------------------------------------------------------------
# normalize_activity
# ---------------------------------------------------------------------------


class TestNormalizeActivity:
    def test_extracts_expected_fields(self):
        raw = {
            "id": 42,
            "name": "Morning Run",
            "type": "Run",
            "sport_type": "Run",
            "start_date": "2026-01-02T05:00:00Z",
            "start_date_local": "2026-01-02T06:00:00Z",
            "distance": 5000.0,
            "moving_time": 1800,
            "elapsed_time": 1850,
            "total_elevation_gain": 30.5,
            "average_speed": 2.77,
            "max_speed": 4.1,
            "average_heartrate": 145.0,
            "max_heartrate": 170.0,
            "calories": 400,
            "kudos_count": 3,
            "achievement_count": 2,
            "map": {"summary_polyline": "abc123"},
        }
        result = normalize_activity(raw)

        assert result["id"] == 42
        assert result["name"] == "Morning Run"
        assert result["type"] == "Run"
        assert result["sport_type"] == "Run"
        assert result["start_date"] == "2026-01-02T05:00:00Z"
        assert result["start_date_local"] == "2026-01-02T06:00:00Z"
        assert result["distance_m"] == 5000.0
        assert result["moving_time_s"] == 1800
        assert result["elapsed_time_s"] == 1850
        assert result["elevation_gain_m"] == 30.5
        assert result["average_speed_mps"] == 2.77
        assert result["max_speed_mps"] == 4.1
        assert result["average_heartrate"] == 145.0
        assert result["max_heartrate"] == 170.0
        assert result["calories"] == 400
        assert result["kudos_count"] == 3
        assert result["achievement_count"] == 2
        assert result["map_summary_polyline"] == "abc123"

    def test_handles_missing_fields_gracefully(self):
        result = normalize_activity({})
        assert result["id"] is None
        assert result["name"] is None
        assert result["distance_m"] is None
        assert result["map_summary_polyline"] is None

    def test_handles_missing_map_key(self):
        raw = {"id": 1, "name": "Ride"}
        result = normalize_activity(raw)
        assert result["map_summary_polyline"] is None

    def test_handles_null_map_key(self):
        raw = {"id": 1, "map": None}
        result = normalize_activity(raw)
        assert result["map_summary_polyline"] is None

    def test_does_not_include_token_fields(self):
        raw = {
            "id": 1,
            "access_token": "secret",
            "refresh_token": "also_secret",
        }
        result = normalize_activity(raw)
        assert "access_token" not in result
        assert "refresh_token" not in result


# ---------------------------------------------------------------------------
# write_output
# ---------------------------------------------------------------------------


class TestWriteOutput:
    def test_creates_output_directory(self, tmp_path):
        output_dir = tmp_path / "strava" / "activities"
        assert not output_dir.exists()
        write_output([], output_dir)
        assert output_dir.is_dir()

    def test_writes_latest_json(self, tmp_path):
        activities = [{"id": 1, "name": "Run"}]
        write_output(activities, tmp_path)
        latest = tmp_path / "latest.json"
        assert latest.exists()
        data = json.loads(latest.read_text(encoding="utf-8"))
        assert data["activity_count"] == 1
        assert data["activities"] == activities
        assert "fetched_at" in data

    def test_writes_timestamped_file(self, tmp_path):
        write_output([{"id": 1}], tmp_path)
        timestamped = list(tmp_path.glob("activities_*.json"))
        assert len(timestamped) == 1

    def test_latest_json_is_valid_json(self, tmp_path):
        write_output([{"id": 1, "name": "Swim"}], tmp_path)
        content = (tmp_path / "latest.json").read_text(encoding="utf-8")
        data = json.loads(content)
        assert isinstance(data, dict)

    def test_does_not_corrupt_latest_on_empty_activities(self, tmp_path):
        # Pre-populate latest.json with valid data.
        existing = {"fetched_at": "2026-01-01T00:00:00+00:00", "activity_count": 5, "activities": []}
        (tmp_path / "latest.json").write_text(json.dumps(existing), encoding="utf-8")

        write_output([], tmp_path)

        data = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
        assert data["activity_count"] == 0  # updated, not corrupted

    def test_tmp_file_is_removed_after_write(self, tmp_path):
        write_output([], tmp_path)
        assert not (tmp_path / "latest.json.tmp").exists()


# ---------------------------------------------------------------------------
# run() integration (mocked externals)
# ---------------------------------------------------------------------------


class TestRun:
    def _make_env(self):
        return {
            "STRAVA_CLIENT_ID": "123",
            "STRAVA_CLIENT_SECRET": "secret",
            "STRAVA_REFRESH_TOKEN": "reftok",
        }

    def test_run_completes_without_error(self, tmp_path, monkeypatch):
        import logging

        dummy_log = logging.getLogger("_test_strava_run")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.strava_sync.get_logger", lambda *a, **kw: dummy_log)

        monkeypatch.setattr(
            "scripts.strava_sync.require_env", lambda *a, **kw: self._make_env()
        )
        monkeypatch.setattr(
            "scripts.strava_sync.refresh_access_token", lambda *a, **kw: "tok_xyz"
        )
        monkeypatch.setattr(
            "scripts.strava_sync.fetch_activities",
            lambda *a, **kw: [{"id": 1, "name": "Run", "map": None}],
        )
        monkeypatch.setenv("STRAVA_OUTPUT_DIR", str(tmp_path))

        run()  # Should not raise.

        latest = tmp_path / "latest.json"
        assert latest.exists()
        data = json.loads(latest.read_text(encoding="utf-8"))
        assert data["activity_count"] == 1

    def test_run_raises_when_env_vars_missing(self, monkeypatch):
        import logging

        dummy_log = logging.getLogger("_test_strava_env_missing")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.strava_sync.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setattr(
            "scripts.strava_sync.require_env",
            lambda *a, **kw: (_ for _ in ()).throw(
                RuntimeError("STRAVA_CLIENT_ID is not set")
            ),
        )
        with pytest.raises(RuntimeError, match="STRAVA_CLIENT_ID"):
            run()

    def test_run_raises_when_token_refresh_fails(self, tmp_path, monkeypatch):
        import logging

        dummy_log = logging.getLogger("_test_strava_token_fail")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.strava_sync.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setattr(
            "scripts.strava_sync.require_env", lambda *a, **kw: self._make_env()
        )
        monkeypatch.setattr(
            "scripts.strava_sync.refresh_access_token",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("Token refresh failed")),
        )
        monkeypatch.setenv("STRAVA_OUTPUT_DIR", str(tmp_path))

        with pytest.raises(RuntimeError, match="Token refresh failed"):
            run()

    def test_run_raises_when_fetch_fails(self, tmp_path, monkeypatch):
        import logging

        dummy_log = logging.getLogger("_test_strava_fetch_fail")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.strava_sync.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setattr(
            "scripts.strava_sync.require_env", lambda *a, **kw: self._make_env()
        )
        monkeypatch.setattr(
            "scripts.strava_sync.refresh_access_token", lambda *a, **kw: "tok"
        )
        monkeypatch.setattr(
            "scripts.strava_sync.fetch_activities",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("API error")),
        )
        monkeypatch.setenv("STRAVA_OUTPUT_DIR", str(tmp_path))

        with pytest.raises(RuntimeError, match="API error"):
            run()

    def test_run_handles_zero_activities(self, tmp_path, monkeypatch):
        import logging

        dummy_log = logging.getLogger("_test_strava_zero")
        dummy_log.addHandler(logging.NullHandler())
        monkeypatch.setattr("scripts.strava_sync.get_logger", lambda *a, **kw: dummy_log)
        monkeypatch.setattr(
            "scripts.strava_sync.require_env", lambda *a, **kw: self._make_env()
        )
        monkeypatch.setattr(
            "scripts.strava_sync.refresh_access_token", lambda *a, **kw: "tok"
        )
        monkeypatch.setattr(
            "scripts.strava_sync.fetch_activities", lambda *a, **kw: []
        )
        monkeypatch.setenv("STRAVA_OUTPUT_DIR", str(tmp_path))

        run()  # Should not raise even with no activities.
        data = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
        assert data["activity_count"] == 0


# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------


class TestModuleConstants:
    def test_description_is_set(self):
        assert isinstance(DESCRIPTION, str)
        assert len(DESCRIPTION) > 0

    def test_default_lookback_days(self):
        assert _DEFAULT_LOOKBACK_DAYS == 1

    def test_default_max_retries(self):
        assert _DEFAULT_MAX_RETRIES == 3

    def test_token_url(self):
        assert _STRAVA_TOKEN_URL == "https://www.strava.com/oauth/token"

    def test_activities_url(self):
        assert _STRAVA_ACTIVITIES_URL == "https://www.strava.com/api/v3/athlete/activities"
