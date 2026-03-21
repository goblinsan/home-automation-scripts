#!/usr/bin/env bash
# =============================================================================
# deploy/rollback.sh – Roll back the gateway service to the previous slot.
#
# WHAT IT DOES
#   1. Reads the currently active color from the state file.
#   2. Determines the alternate slot as the rollback target.
#   3. Starts that slot if it is not already running.
#   4. Verifies the rollback target directly on its bound port.
#   5. Switches nginx back to it.
#   6. Verifies the slot through nginx.
#   7. Updates the state file.
#   8. Optionally stops the slot that was just rolled back from.
#
# USAGE
#   bash deploy/rollback.sh [OPTIONS]
#
# OPTIONS
#   --no-stop-current  Keep the current slot running after rollback.
#   --dry-run          Print the steps without making changes.
#   -h, --help         Show this help text and exit.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="/var/lib/home-automation/active_color"
NGINX_UPSTREAM_CONF="/etc/nginx/conf.d/gateway-active-upstream.conf"
SMOKE_TEST_SCRIPT="${REPO_ROOT}/deploy/smoke_test.sh"
LOCK_FILE="/tmp/home-automation-gateway-deploy.lock"
BLUE_PORT=8081
GREEN_PORT=8082
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=2
PROXY_HEALTH_URL="http://127.0.0.1/health"

STOP_CURRENT=true
DRY_RUN=false

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
  sed -n '/^# USAGE/,/^# =============================================================================$/{ /^# \{0,2\}/p; }' "${BASH_SOURCE[0]}" \
    | sed 's/^# \{0,2\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-stop-current) STOP_CURRENT=false ;;
    --dry-run)         DRY_RUN=true ;;
    -h|--help)         show_help ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

acquire_lock() {
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    die "Another deployment or rollback is already in progress."
  fi
}

read_active_color() {
  if [[ -f "${STATE_FILE}" ]]; then
    local color
    color="$(tr -d '[:space:]' < "${STATE_FILE}")"
    if [[ "${color}" == "blue" || "${color}" == "green" ]]; then
      echo "${color}"
      return
    fi
    die "State file '${STATE_FILE}' contains invalid value: '${color}'."
  fi
  die "State file '${STATE_FILE}' not found. Cannot determine current active color."
}

write_active_color() {
  local color="$1"
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] printf '%s\n' '${color}' | sudo tee '${STATE_FILE}' >/dev/null"
    return
  fi

  printf '%s\n' "${color}" | sudo tee "${STATE_FILE}" >/dev/null
  log "State file updated: active color is now '${color}'."
}

opposite_color() {
  [[ "$1" == "blue" ]] && echo "green" || echo "blue"
}

port_for_color() {
  [[ "$1" == "blue" ]] && echo "${BLUE_PORT}" || echo "${GREEN_PORT}"
}

is_service_running() {
  systemctl is-active --quiet "gateway-$1.service" 2>/dev/null
}

start_service() {
  local color="$1"
  log "Starting gateway-${color}.service..."
  run sudo systemctl restart "gateway-${color}.service"
}

stop_service() {
  local color="$1"
  log "Stopping gateway-${color}.service..."
  run sudo systemctl stop "gateway-${color}.service"
}

wait_for_healthy() {
  local color="$1"
  local url="http://127.0.0.1:$(port_for_color "${color}")/health"

  log "Waiting for gateway-${color} to become healthy at ${url}..."

  local attempt=0
  while [[ ${attempt} -lt ${HEALTH_CHECK_RETRIES} ]]; do
    attempt=$(( attempt + 1 ))

    if [[ "${DRY_RUN}" == true ]]; then
      log "[dry-run] Smoke test attempt ${attempt}/${HEALTH_CHECK_RETRIES} -> ${url}"
      return 0
    fi

    if "${SMOKE_TEST_SCRIPT}" --url "${url}" --expect-color "${color}" >/dev/null 2>&1; then
      log "gateway-${color} is healthy after ${attempt} attempt(s)."
      return 0
    fi

    log "  Attempt ${attempt}/${HEALTH_CHECK_RETRIES} failed; retrying in ${HEALTH_CHECK_INTERVAL}s..."
    sleep "${HEALTH_CHECK_INTERVAL}"
  done

  die "Health check for gateway-${color} timed out. Rollback aborted – nginx not changed."
}

switch_nginx_upstream() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"

  log "Switching nginx upstream to gateway-${color} (port ${port})..."

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
    echo "[dry-run] Would run: sudo nginx -t && sudo nginx -s reload"
    return
  fi

  local tmp_file
  tmp_file="$(mktemp /tmp/gateway-upstream-XXXXXX.conf)"
  echo "${new_conf}" > "${tmp_file}"
  sudo mv "${tmp_file}" "${NGINX_UPSTREAM_CONF}"
  sudo nginx -t
  sudo nginx -s reload
}

verify_proxy_health() {
  local color="$1"

  if [[ "${DRY_RUN}" == true ]]; then
    log "[dry-run] Proxy smoke test -> ${PROXY_HEALTH_URL}"
    return 0
  fi

  "${SMOKE_TEST_SCRIPT}" --url "${PROXY_HEALTH_URL}" --expect-color "${color}"
}

main() {
  log "==============================="
  log "  Gateway Blue-Green Rollback  "
  log "==============================="
  [[ "${DRY_RUN}" == true ]] && log "DRY-RUN MODE – no destructive changes will be made."

  [[ -x "${SMOKE_TEST_SCRIPT}" ]] || die "Smoke test script is missing or not executable: ${SMOKE_TEST_SCRIPT}"
  acquire_lock

  local current_color
  current_color="$(read_active_color)"
  local rollback_color
  rollback_color="$(opposite_color "${current_color}")"

  log "Currently active: ${current_color}"
  log "Rolling back to:  ${rollback_color}"

  if [[ "${DRY_RUN}" == false ]] && ! is_service_running "${rollback_color}"; then
    log "gateway-${rollback_color} is not running; starting it now..."
    start_service "${rollback_color}"
  else
    log "gateway-${rollback_color} is already running."
  fi

  wait_for_healthy "${rollback_color}"
  switch_nginx_upstream "${rollback_color}"

  if ! verify_proxy_health "${rollback_color}"; then
    warn "Proxy smoke test failed after rollback switch; restoring nginx to gateway-${current_color}."
    switch_nginx_upstream "${current_color}"
    die "Proxy smoke test failed after rollback."
  fi

  write_active_color "${rollback_color}"

  if [[ "${STOP_CURRENT}" == true ]]; then
    stop_service "${current_color}"
  else
    log "Leaving gateway-${current_color} running (--no-stop-current specified)."
  fi

  log ""
  log "Rollback complete."
  log "  Active slot : gateway-${rollback_color}"
  log "  Previous slot: gateway-${current_color} $(${STOP_CURRENT} && echo '(stopped)' || echo '(still running)')"
}

main
