"""Tests for gateway/app.py – unit tests for the gateway Flask application."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


# ---------------------------------------------------------------------------
# Helpers to construct a test Flask client with controlled env vars.
# ---------------------------------------------------------------------------


def _make_client(env_overrides: dict | None = None):
    """Import gateway.app with patched environment and return a test client.

    Each call re-imports the module so that module-level env reads are fresh.
    """
    import importlib
    import os

    defaults = {
        "GATEWAY_PORT": "8081",
        "GATEWAY_COLOR": "blue",
        "HA_URL": "http://homeassistant.test:8123",
        "HA_TOKEN": "test-token",
        "GATEWAY_SECRET": "",
    }
    overrides = {**defaults, **(env_overrides or {})}

    with patch.dict(os.environ, overrides, clear=False):
        # Force re-import so module-level constants pick up the patched env.
        if "gateway.app" in sys.modules:
            del sys.modules["gateway.app"]
        import gateway.app as gw_app

        gw_app.app.config["TESTING"] = True
        return gw_app.app.test_client(), gw_app


# ---------------------------------------------------------------------------
# /health endpoint
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_returns_200_when_ha_reachable(self):
        client, gw_app = _make_client()
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch.object(gw_app, "_check_ha_reachable", return_value=(True, "ha_status=200")):
            resp = client.get("/health")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert data["ha_reachable"] is True

    def test_returns_503_when_ha_unreachable(self):
        client, gw_app = _make_client()

        with patch.object(gw_app, "_check_ha_reachable", return_value=(False, "connection_error: refused")):
            resp = client.get("/health")

        assert resp.status_code == 503
        data = resp.get_json()
        assert data["status"] == "degraded"
        assert data["ha_reachable"] is False

    def test_includes_color_in_response(self):
        client, gw_app = _make_client({"GATEWAY_COLOR": "green"})

        with patch.object(gw_app, "_check_ha_reachable", return_value=(True, "ha_status=200")):
            resp = client.get("/health")

        data = resp.get_json()
        assert data["color"] == "green"

    def test_includes_port_in_response(self):
        client, gw_app = _make_client({"GATEWAY_PORT": "8082"})

        with patch.object(gw_app, "_check_ha_reachable", return_value=(True, "ok")):
            resp = client.get("/health")

        data = resp.get_json()
        assert data["port"] == 8082

    def test_health_accessible_without_secret(self):
        """The /health endpoint must be unauthenticated."""
        client, gw_app = _make_client({"GATEWAY_SECRET": "supersecret"})

        with patch.object(gw_app, "_check_ha_reachable", return_value=(True, "ok")):
            # No X-Gateway-Secret header sent.
            resp = client.get("/health")

        # Health should still succeed even without the secret.
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# _check_ha_reachable helper
# ---------------------------------------------------------------------------


class TestCheckHaReachable:
    def test_returns_true_on_200(self):
        _, gw_app = _make_client()
        mock_resp = MagicMock(status_code=200)

        with patch("gateway.app.requests.get", return_value=mock_resp):
            reachable, detail = gw_app._check_ha_reachable()

        assert reachable is True
        assert "200" in detail

    def test_returns_true_on_401(self):
        """HA returns 401 when the token is invalid – HA is still running."""
        _, gw_app = _make_client()
        mock_resp = MagicMock(status_code=401)

        with patch("gateway.app.requests.get", return_value=mock_resp):
            reachable, detail = gw_app._check_ha_reachable()

        assert reachable is True

    def test_returns_false_on_connection_error(self):
        import requests as req_lib

        _, gw_app = _make_client()

        with patch("gateway.app.requests.get", side_effect=req_lib.exceptions.ConnectionError("refused")):
            reachable, detail = gw_app._check_ha_reachable()

        assert reachable is False
        assert "connection_error" in detail

    def test_returns_false_on_timeout(self):
        import requests as req_lib

        _, gw_app = _make_client()

        with patch("gateway.app.requests.get", side_effect=req_lib.exceptions.Timeout()):
            reachable, detail = gw_app._check_ha_reachable()

        assert reachable is False
        assert "timeout" in detail

    def test_returns_false_when_ha_url_empty(self):
        _, gw_app = _make_client({"HA_URL": ""})
        reachable, detail = gw_app._check_ha_reachable()

        assert reachable is False
        assert "HA_URL" in detail


# ---------------------------------------------------------------------------
# Proxy endpoint
# ---------------------------------------------------------------------------


class TestProxyEndpoint:
    def _make_upstream_response(self, status_code: int = 200, content: bytes = b"{}"):
        mock_resp = MagicMock()
        mock_resp.status_code = status_code
        mock_resp.content = content
        mock_resp.raw.headers = {}
        return mock_resp

    def test_proxies_get_request(self):
        client, gw_app = _make_client()
        mock_resp = self._make_upstream_response()

        with patch("gateway.app.requests.request", return_value=mock_resp) as mock_req:
            resp = client.get("/api/states")

        assert mock_req.called
        args, kwargs = mock_req.call_args
        assert kwargs.get("method") == "GET" or args[0] == "GET"

    def test_proxies_post_request(self):
        client, gw_app = _make_client()
        mock_resp = self._make_upstream_response(status_code=201, content=b'{"id":1}')

        with patch("gateway.app.requests.request", return_value=mock_resp):
            resp = client.post("/api/services/light/turn_on", json={"entity_id": "light.test"})

        assert resp.status_code == 201

    def test_injects_ha_token(self):
        client, gw_app = _make_client({"HA_TOKEN": "my-secret-token"})
        mock_resp = self._make_upstream_response()

        with patch("gateway.app.requests.request", return_value=mock_resp) as mock_req:
            client.get("/api/states")

        _, kwargs = mock_req.call_args
        sent_headers = kwargs.get("headers", {})
        assert sent_headers.get("Authorization") == "Bearer my-secret-token"

    def test_returns_403_on_invalid_secret(self):
        client, gw_app = _make_client({"GATEWAY_SECRET": "correct-secret"})

        resp = client.get("/api/states", headers={"X-Gateway-Secret": "wrong-secret"})

        assert resp.status_code == 403

    def test_returns_200_with_correct_secret(self):
        client, gw_app = _make_client({"GATEWAY_SECRET": "correct-secret"})
        mock_resp = self._make_upstream_response()

        with patch("gateway.app.requests.request", return_value=mock_resp):
            resp = client.get("/api/states", headers={"X-Gateway-Secret": "correct-secret"})

        assert resp.status_code == 200

    def test_returns_502_on_connection_error(self):
        import requests as req_lib

        client, gw_app = _make_client()

        with patch("gateway.app.requests.request", side_effect=req_lib.exceptions.ConnectionError("refused")):
            resp = client.get("/api/states")

        assert resp.status_code == 502

    def test_returns_504_on_timeout(self):
        import requests as req_lib

        client, gw_app = _make_client()

        with patch("gateway.app.requests.request", side_effect=req_lib.exceptions.Timeout()):
            resp = client.get("/api/states")

        assert resp.status_code == 504

    def test_returns_502_when_ha_url_missing(self):
        client, gw_app = _make_client({"HA_URL": ""})

        resp = client.get("/api/states")

        assert resp.status_code == 502

    def test_strips_x_gateway_secret_from_upstream_headers(self):
        """The gateway secret must not be forwarded to Home Assistant."""
        client, gw_app = _make_client({"GATEWAY_SECRET": "my-secret"})
        mock_resp = self._make_upstream_response()

        with patch("gateway.app.requests.request", return_value=mock_resp) as mock_req:
            client.get("/api/states", headers={"X-Gateway-Secret": "my-secret"})

        _, kwargs = mock_req.call_args
        sent_headers = kwargs.get("headers", {})
        assert "x-gateway-secret" not in {k.lower() for k in sent_headers}

    def test_preserves_upstream_status_code(self):
        client, gw_app = _make_client()
        mock_resp = self._make_upstream_response(status_code=404)

        with patch("gateway.app.requests.request", return_value=mock_resp):
            resp = client.get("/api/nonexistent")

        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# _validate_secret helper
# ---------------------------------------------------------------------------


class TestValidateSecret:
    def test_returns_true_when_secret_not_configured(self):
        _, gw_app = _make_client({"GATEWAY_SECRET": ""})
        # No request context needed – GATEWAY_SECRET is empty so bypass is on.
        # We push an application context to satisfy Flask's request proxy.
        with gw_app.app.test_request_context("/"):
            assert gw_app._validate_secret() is True

    def test_returns_true_with_correct_secret(self):
        _, gw_app = _make_client({"GATEWAY_SECRET": "s3cr3t"})
        with gw_app.app.test_request_context(
            "/", headers={"X-Gateway-Secret": "s3cr3t"}
        ):
            assert gw_app._validate_secret() is True

    def test_returns_false_with_wrong_secret(self):
        _, gw_app = _make_client({"GATEWAY_SECRET": "s3cr3t"})
        with gw_app.app.test_request_context(
            "/", headers={"X-Gateway-Secret": "wrong"}
        ):
            assert gw_app._validate_secret() is False

    def test_returns_false_when_header_missing(self):
        _, gw_app = _make_client({"GATEWAY_SECRET": "s3cr3t"})
        with gw_app.app.test_request_context("/"):
            assert gw_app._validate_secret() is False
