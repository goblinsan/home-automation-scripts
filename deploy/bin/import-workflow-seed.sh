#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --experimental-strip-types "${REPO_ROOT}/src/cli.ts" import-workflow-seed "$@"
