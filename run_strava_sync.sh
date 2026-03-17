#!/usr/bin/env bash
# =============================================================================
# run_strava_sync.sh – Wrapper script for the Strava activity sync job.
#
# Usage:
#   ./run_strava_sync.sh
#
# This script is designed to be called directly from cron or the command line.
# It:
#   1. Changes to the repository root (the directory containing this script).
#   2. Loads a .env file if present (existing environment variables are
#      preserved and not overridden).
#   3. Activates the Python virtual environment when .venv/ exists.
#   4. Runs the Strava sync Python script.
#   5. Exits non-zero when the sync fails so cron can log the failure.
#
# Example cron entry (add via `crontab -e` or the cron_installer helper):
#
#   0 6 * * * /usr/bin/env bash -c 'cd /path/to/repo && ./run_strava_sync.sh >> logs/strava.log 2>&1'
#
# Or via the automation CLI (substitutes $REPO_ROOT / $PYTHON automatically):
#
#   0 6 * * * $PYTHON $REPO_ROOT/tools/automation.py run strava-sync >> $REPO_ROOT/logs/strava.log 2>&1
#
# See docs/strava_sync.md for full installation and configuration instructions.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve the repository root (the directory containing this script).
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Logging helpers (timestamps match the Python logger format).
# ---------------------------------------------------------------------------

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO ] run_strava_sync: $*"; }
warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN ] run_strava_sync: $*" >&2; }
die()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] run_strava_sync: $*" >&2; exit 1; }

log "Starting Strava sync …"
log "Repository root: ${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Load .env if present (do not override variables already set in the shell).
# ---------------------------------------------------------------------------

if [[ -f "${REPO_ROOT}/.env" ]]; then
    log "Loading environment from ${REPO_ROOT}/.env"
    set -o allexport
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/.env"
    set +o allexport
fi

# ---------------------------------------------------------------------------
# Activate the Python virtual environment (created by install.sh).
# ---------------------------------------------------------------------------

VENV_ACTIVATE="${REPO_ROOT}/.venv/bin/activate"
if [[ -f "${VENV_ACTIVATE}" ]]; then
    log "Activating virtual environment: ${VENV_ACTIVATE}"
    # shellcheck source=/dev/null
    source "${VENV_ACTIVATE}"
    PYTHON="${REPO_ROOT}/.venv/bin/python3"
else
    warn ".venv not found – using system Python.  Run install.sh to create one."
    PYTHON="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
fi

if [[ -z "${PYTHON:-}" ]]; then
    die "Python interpreter not found.  Install Python 3 or run install.sh."
fi

log "Python interpreter: ${PYTHON}"

# ---------------------------------------------------------------------------
# Run the Strava sync script.
# ---------------------------------------------------------------------------

log "Running Strava sync …"
if "${PYTHON}" "${REPO_ROOT}/scripts/strava_sync.py"; then
    log "Strava sync completed successfully."
else
    die "Strava sync failed."
fi
