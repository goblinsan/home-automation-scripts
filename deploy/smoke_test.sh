#!/usr/bin/env bash
# =============================================================================
# deploy/smoke_test.sh – Minimal health smoke test for the gateway service.
#
# USAGE
#   bash deploy/smoke_test.sh --url http://127.0.0.1:8081/health [--expect-color blue]
# =============================================================================

set -euo pipefail

URL=""
EXPECT_COLOR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)          URL="${2:?--url requires a value}"; shift ;;
    --expect-color) EXPECT_COLOR="${2:?--expect-color requires a value}"; shift ;;
    -h|--help)
      sed -n '/^# USAGE/,/^# =============================================================================$/{ /^# \{0,2\}/p; }' "${BASH_SOURCE[0]}" \
        | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

[[ -n "${URL}" ]] || { echo "--url is required" >&2; exit 1; }

python3 - "${URL}" "${EXPECT_COLOR}" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = sys.argv[1]
expect_color = sys.argv[2]

try:
    with urllib.request.urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise SystemExit(f"unexpected HTTP status: {response.status}")
        payload = json.load(response)
except urllib.error.URLError as exc:
    raise SystemExit(f"request failed: {exc}") from exc

status = payload.get("status")
if status != "ok":
    raise SystemExit(f"unexpected status payload: {status!r}")

if expect_color and payload.get("color") != expect_color:
    raise SystemExit(
        f"unexpected color payload: {payload.get('color')!r} != {expect_color!r}"
    )
PY
