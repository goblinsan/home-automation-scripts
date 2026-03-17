#!/usr/bin/env python3
"""
gateway/app.py – Home-automation gateway service.

Acts as a thin reverse-proxy and authentication layer in front of Home
Assistant (or another local API).  Two instances run simultaneously on
different ports (blue = GATEWAY_PORT 8081, green = GATEWAY_PORT 8082);
nginx routes live traffic to whichever instance is currently "active".

Environment variables (all required unless marked optional):
    GATEWAY_PORT       TCP port this instance listens on.  Default: 8081.
    GATEWAY_COLOR      Deployment slot: "blue" or "green".  Default: "blue".
    HA_URL             Base URL of the Home Assistant instance.
                       Example: http://homeassistant.local:8123
    HA_TOKEN           Long-lived access token for Home Assistant.
    GATEWAY_SECRET     (optional) Shared secret expected in the
                       X-Gateway-Secret request header.  If unset, the
                       secret check is skipped (not recommended for
                       Internet-facing deployments).

Health endpoint:
    GET /health
        Returns HTTP 200 {"status": "ok", ...} when the gateway is running
        and Home Assistant is reachable.
        Returns HTTP 503 if Home Assistant is unreachable.

Proxy endpoint:
    ANY /<path>
        Forwards the request to HA_URL/<path>, injecting the HA bearer token.
        Returns the upstream response verbatim (headers, body, status code).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure repo root is on sys.path so shared tools can be imported.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import requests
from flask import Flask, Response, jsonify, request

from tools.logger import get_logger  # noqa: E402 (repo tool)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GATEWAY_PORT: int = int(os.environ.get("GATEWAY_PORT", "8081"))
GATEWAY_COLOR: str = os.environ.get("GATEWAY_COLOR", "blue")
HA_URL: str = os.environ.get("HA_URL", "")
HA_TOKEN: str = os.environ.get("HA_TOKEN", "")
GATEWAY_SECRET: str = os.environ.get("GATEWAY_SECRET", "")

# How long (seconds) to wait for Home Assistant to respond.
_HA_TIMEOUT: int = 5

# ---------------------------------------------------------------------------
# App and logger
# ---------------------------------------------------------------------------

app = Flask(__name__)
log = get_logger(f"gateway-{GATEWAY_COLOR}")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ha_headers() -> dict[str, str]:
    """Return the Authorization header required by Home Assistant."""
    return {"Authorization": f"Bearer {HA_TOKEN}"}


def _check_ha_reachable() -> tuple[bool, str]:
    """Probe Home Assistant and return (reachable, detail_message).

    Performs a lightweight GET to the HA API root.  A 200 or 401 response
    both indicate that HA is up (401 means HA is running but our probe hit an
    endpoint that requires auth without sending credentials).

    Returns:
        (True, "ok")                 when HA responds with any 2xx/4xx.
        (False, "<reason string>")   when HA is unreachable or times out.
    """
    if not HA_URL:
        return False, "HA_URL is not configured"
    try:
        resp = requests.get(
            f"{HA_URL}/api/",
            headers=_ha_headers(),
            timeout=_HA_TIMEOUT,
        )
        # Any HTTP response (even 4xx) means HA is running.
        return True, f"ha_status={resp.status_code}"
    except requests.exceptions.ConnectionError as exc:
        return False, f"connection_error: {exc}"
    except requests.exceptions.Timeout:
        return False, f"timeout after {_HA_TIMEOUT}s"
    except requests.exceptions.RequestException as exc:
        return False, f"request_error: {exc}"


def _validate_secret() -> bool:
    """Return True if the request carries the correct gateway secret.

    When GATEWAY_SECRET is empty the check is bypassed and True is returned.
    """
    if not GATEWAY_SECRET:
        return True
    return request.headers.get("X-Gateway-Secret", "") == GATEWAY_SECRET


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/health", methods=["GET"])
def health() -> tuple[Response, int]:
    """Liveness + readiness probe.

    Checks that this process is running *and* that Home Assistant is
    reachable.  Returns 200 on success, 503 on failure.

    This endpoint is intentionally unauthenticated so that nginx, systemd,
    and the deploy script can call it without credentials.
    """
    reachable, detail = _check_ha_reachable()
    payload = {
        "status": "ok" if reachable else "degraded",
        "color": GATEWAY_COLOR,
        "port": GATEWAY_PORT,
        "ha_reachable": reachable,
        "detail": detail,
    }
    status_code = 200 if reachable else 503
    if reachable:
        log.info("Health check passed – %s", detail)
    else:
        log.warning("Health check failed – %s", detail)
    return jsonify(payload), status_code


@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def proxy(path: str) -> tuple[Response, int]:
    """Forward all requests to Home Assistant.

    Injects the HA bearer token and, optionally, validates the gateway
    secret supplied by the caller.  Returns the upstream response verbatim.
    """
    if not _validate_secret():
        log.warning("Rejected request – invalid or missing X-Gateway-Secret")
        return jsonify({"error": "forbidden"}), 403

    if not HA_URL:
        log.error("HA_URL is not configured – cannot proxy request")
        return jsonify({"error": "gateway misconfigured"}), 502

    target_url = f"{HA_URL}/{path}"
    headers = {
        key: value
        for key, value in request.headers
        if key.lower() not in ("host", "x-gateway-secret")
    }
    headers.update(_ha_headers())

    log.info("Proxying %s %s -> %s", request.method, request.path, target_url)

    try:
        upstream_resp = requests.request(
            method=request.method,
            url=target_url,
            headers=headers,
            params=request.args,
            data=request.get_data(),
            timeout=_HA_TIMEOUT,
            allow_redirects=False,
        )
    except requests.exceptions.ConnectionError as exc:
        log.error("Connection error proxying to HA: %s", exc)
        return jsonify({"error": "upstream unreachable"}), 502
    except requests.exceptions.Timeout:
        log.error("Timeout proxying to HA after %ss", _HA_TIMEOUT)
        return jsonify({"error": "upstream timeout"}), 504
    except requests.exceptions.RequestException as exc:
        log.error("Unexpected error proxying to HA: %s", exc)
        return jsonify({"error": "upstream error"}), 502

    # Strip hop-by-hop headers that must not be forwarded.
    excluded_headers = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
    response_headers = [
        (name, value)
        for name, value in upstream_resp.raw.headers.items()
        if name.lower() not in excluded_headers
    ]

    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        headers=response_headers,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _validate_config() -> None:
    """Abort with a clear message if required environment variables are missing."""
    missing = []
    if not HA_URL:
        missing.append("HA_URL")
    if not HA_TOKEN:
        missing.append("HA_TOKEN")
    if missing:
        log.error(
            "Required environment variable(s) not set: %s. "
            "Copy ops/systemd/gateway-%s.env.example to "
            "/etc/home-automation/gateway-%s.env and fill in the values.",
            ", ".join(missing),
            GATEWAY_COLOR,
            GATEWAY_COLOR,
        )
        sys.exit(1)


if __name__ == "__main__":
    _validate_config()
    log.info(
        "Starting gateway-%s on port %s (HA_URL=%s)",
        GATEWAY_COLOR,
        GATEWAY_PORT,
        HA_URL,
    )
    app.run(host="127.0.0.1", port=GATEWAY_PORT, debug=False)
