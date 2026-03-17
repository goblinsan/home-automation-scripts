#!/usr/bin/env bash
# =============================================================================
# deploy/rollback.sh – Roll back the gateway service to the previously active
#                      deployment color.
#
# WHAT IT DOES
#   1. Reads the currently active color from the state file.
#   2. Determines the alternate color (the one to roll back to).
#   3. Checks that the alternate instance is already running; if not, starts it.
#   4. Verifies the alternate instance is healthy via /health.
#   5. Switches the nginx upstream back to the alternate instance.
#   6. Updates the state file.
#   7. Optionally stops the instance that was just cut over from.
#
# USAGE
#   bash deploy/rollback.sh [OPTIONS]
#
# OPTIONS
#   --no-stop-current  Keep the previously active (now-failing) instance
#                      running after rollback.  Default: stop it.
#   --dry-run          Print every step without making changes.
#   -h, --help         Show this help text and exit.
#
# NOTES
#   Rollback only works if the alternate instance is still available
#   (i.e. the previous deploy used --no-stop-old, or the service was never
#   stopped).  If the alternate instance cannot be started and made healthy,
#   the rollback aborts safely without touching nginx.
#
# EXIT CODES
#   0  Rollback succeeded.
#   1  Rollback failed.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="/var/lib/home-automation/active_color"
NGINX_UPSTREAM_CONF="/etc/nginx/conf.d/gateway-active-upstream.conf"
BLUE_PORT=8081
GREEN_PORT=8082
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=2

STOP_CURRENT=true
DRY_RUN=false

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[rollback] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
warn() { echo "[rollback] WARNING: $*" >&2; }
die()  { echo "[rollback] ERROR: $*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

show_help() {
  sed -n '/^# USAGE/,/^# EXIT CODES/{ /^#/{ s/^# \{0,2\}//; p }; }' "${BASH_SOURCE[0]}"
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-stop-current) STOP_CURRENT=false ;;
    --dry-run)         DRY_RUN=true ;;
    -h|--help)         show_help ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers (shared with deploy.sh)
# ---------------------------------------------------------------------------

read_active_color() {
  if [[ -f "${STATE_FILE}" ]]; then
    local color
    color="$(tr -d '[:space:]' < "${STATE_FILE}")"
    if [[ "${color}" == "blue" || "${color}" == "green" ]]; then
      echo "${color}"
      return
    fi
    die "State file contains invalid value: '${color}'."
  fi
  die "State file '${STATE_FILE}' not found. Cannot determine current active color."
}

write_active_color() {
  local color="$1"
  if [[ "${DRY_RUN}" == false ]]; then
    echo "${color}" > "${STATE_FILE}"
  fi
  log "State file updated: active color is now '${color}'."
}

opposite_color() {
  [[ "$1" == "blue" ]] && echo "green" || echo "blue"
}

port_for_color() {
  [[ "$1" == "blue" ]] && echo "${BLUE_PORT}" || echo "${GREEN_PORT}"
}

is_service_running() {
  local color="$1"
  systemctl is-active --quiet "gateway-${color}.service" 2>/dev/null
}

start_service() {
  local color="$1"
  log "Starting gateway-${color}.service…"
  run sudo systemctl start "gateway-${color}.service"
}

stop_service() {
  local color="$1"
  log "Stopping gateway-${color}.service…"
  run sudo systemctl stop "gateway-${color}.service"
}

wait_for_healthy() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"
  local url="http://127.0.0.1:${port}/health"

  log "Waiting for gateway-${color} to become healthy at ${url}…"

  local attempt=0
  while [[ ${attempt} -lt ${HEALTH_CHECK_RETRIES} ]]; do
    attempt=$(( attempt + 1 ))

    if [[ "${DRY_RUN}" == true ]]; then
      log "[dry-run] Health check attempt ${attempt}/${HEALTH_CHECK_RETRIES} -> ${url}"
      return 0
    fi

    local http_status
    http_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --max-time 3 "${url}" 2>/dev/null || echo "000")"

    if [[ "${http_status}" == "200" ]]; then
      log "gateway-${color} is healthy (HTTP ${http_status}) after ${attempt} attempt(s)."
      return 0
    fi

    log "  Attempt ${attempt}/${HEALTH_CHECK_RETRIES}: HTTP ${http_status} – retrying in ${HEALTH_CHECK_INTERVAL}s…"
    sleep "${HEALTH_CHECK_INTERVAL}"
  done

  die "Health check for gateway-${color} timed out. Rollback aborted – nginx NOT changed."
}

switch_nginx_upstream() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"

  log "Switching nginx upstream back to gateway-${color} (port ${port})…"

  local new_conf
  new_conf="$(cat <<EOF
# Managed by deploy/rollback.sh – do not edit manually.
# Active deployment color: ${color}
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
upstream gateway_active {
    server 127.0.0.1:${port};
    keepalive 32;
}
EOF
)"

  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] Would write to ${NGINX_UPSTREAM_CONF}:"
    echo "${new_conf}"
    echo "[dry-run] Would run: sudo nginx -s reload"
    return
  fi

  local tmp_file
  tmp_file="$(mktemp /tmp/gateway-upstream-XXXXXX.conf)"
  echo "${new_conf}" > "${tmp_file}"
  sudo mv "${tmp_file}" "${NGINX_UPSTREAM_CONF}"
  sudo nginx -s reload

  log "nginx reloaded – traffic now routed to gateway-${color} (port ${port})."
}

# ---------------------------------------------------------------------------
# Main rollback flow
# ---------------------------------------------------------------------------

main() {
  log "==============================="
  log "  Gateway Blue-Green Rollback  "
  log "==============================="
  [[ "${DRY_RUN}" == true ]] && log "DRY-RUN MODE – no destructive changes will be made."

  local current_color
  current_color="$(read_active_color)"
  local rollback_color
  rollback_color="$(opposite_color "${current_color}")"

  log "Currently active: ${current_color}"
  log "Rolling back to:  ${rollback_color}"

  # Ensure the rollback target is running.
  if [[ "${DRY_RUN}" == false ]] && ! is_service_running "${rollback_color}"; then
    log "gateway-${rollback_color} is not running; starting it now…"
    start_service "${rollback_color}"
  else
    log "gateway-${rollback_color} is already running."
  fi

  # Verify the rollback target is healthy before switching.
  wait_for_healthy "${rollback_color}"

  # Switch nginx back.
  switch_nginx_upstream "${rollback_color}"

  # Update state.
  write_active_color "${rollback_color}"

  # Optionally stop the now-inactive (previously active) instance.
  if [[ "${STOP_CURRENT}" == true ]]; then
    stop_service "${current_color}"
  else
    log "Leaving gateway-${current_color} running (--no-stop-current specified)."
  fi

  log ""
  log "✓ Rollback complete."
  log "  Active instance : gateway-${rollback_color} (port $(port_for_color "${rollback_color}"))"
  log "  Previous instance: gateway-${current_color} $(${STOP_CURRENT} && echo '(stopped)' || echo '(still running)')"
}

main
