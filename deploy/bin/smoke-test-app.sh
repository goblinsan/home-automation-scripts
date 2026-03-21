#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
URL="${1:?usage: smoke-test-app.sh <url>}"
node "${REPO_ROOT}/src/cli.ts" smoke-test --url "${URL}"

