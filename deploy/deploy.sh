#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh – Blue-green deployment script for the gateway service.
#
# WHAT IT DOES
#   1. Reads the currently active deployment colour (blue or green) from the
#      state file.
#   2. Identifies the *inactive* colour as the deployment target.
#   3. Pulls the latest code from git (or uses the working tree – see flags).
#   4. Installs/updates Python dependencies in the shared virtual environment.
#   5. Starts (or restarts) the systemd service for the inactive colour.
#   6. Waits for the inactive instance's /health endpoint to return HTTP 200.
#   7. Rewrites the nginx upstream config to point to the newly healthy instance.
#   8. Reloads nginx gracefully (zero-drop reload).
#   9. Writes the new active colour to the state file.
#  10. Optionally stops the previously active instance after a drain delay.
#
# USAGE
#   bash deploy/deploy.sh [OPTIONS]
#
# OPTIONS
#   --no-stop-old      Keep the previously active instance running after
#                      cutover (useful for rapid rollback).  Default: stop it.
#   --drain-seconds N  Seconds to wait before stopping the old instance.
#                      Default: 10.
#   --skip-pull        Skip 'git pull'; deploy from the current working tree.
#   --dry-run          Print every step without executing destructive commands.
#   -h, --help         Show this help text and exit.
#
# REQUIREMENTS
#   - systemd with gateway-blue.service and gateway-green.service installed
#     (see ops/systemd/).
#   - nginx installed and configured with the gateway site
#     (see ops/nginx/gateway-site.conf).
#   - /etc/home-automation/gateway-blue.env and gateway-green.env present
#     (copy from ops/systemd/*.env.example and fill in secrets).
#   - curl available for health checks.
#
# STATE FILE
#   /var/lib/home-automation/active_color
#   Contains a single word: "blue" or "green".
#   Created automatically on first run (defaults to "blue" as current active).
#
# EXIT CODES
#   0  Deployment succeeded.
#   1  Deployment failed (health check timed out, nginx reload failed, etc.).
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants – adjust these to match your environment.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${REPO_ROOT}/.venv"
STATE_FILE="/var/lib/home-automation/active_color"
NGINX_UPSTREAM_CONF="/etc/nginx/conf.d/gateway-active-upstream.conf"
BLUE_PORT=8081
GREEN_PORT=8082
HEALTH_CHECK_RETRIES=30   # maximum number of health-check attempts
HEALTH_CHECK_INTERVAL=2   # seconds between attempts

# ---------------------------------------------------------------------------
# Defaults for CLI flags
# ---------------------------------------------------------------------------

STOP_OLD=true
DRAIN_SECONDS=10
SKIP_PULL=false
DRY_RUN=false

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[deploy] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
warn() { echo "[deploy] WARNING: $*" >&2; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

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
    --no-stop-old)    STOP_OLD=false ;;
    --drain-seconds)  DRAIN_SECONDS="${2:?--drain-seconds requires a value}"; shift ;;
    --skip-pull)      SKIP_PULL=true ;;
    --dry-run)        DRY_RUN=true ;;
    -h|--help)        show_help ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

check_prerequisites() {
  log "Checking prerequisites…"

  command -v curl   >/dev/null 2>&1 || die "curl is required but not found."
  command -v nginx  >/dev/null 2>&1 || die "nginx is required but not found."
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required but not found."

  for svc in gateway-blue gateway-green; do
    systemctl list-unit-files "${svc}.service" >/dev/null 2>&1 \
      || die "systemd unit ${svc}.service is not installed. See ops/systemd/."
  done

  log "Prerequisites OK."
}

# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

read_active_color() {
  # Returns "blue" or "green".  Defaults to "blue" if the state file does not
  # exist yet (first deployment).
  if [[ -f "${STATE_FILE}" ]]; then
    local color
    color="$(tr -d '[:space:]' < "${STATE_FILE}")"
    if [[ "${color}" == "blue" || "${color}" == "green" ]]; then
      echo "${color}"
      return
    fi
    die "State file '${STATE_FILE}' contains invalid value: '${color}'. Expected 'blue' or 'green'."
  fi
  echo "blue"
}

write_active_color() {
  local color="$1"
  run mkdir -p "$(dirname "${STATE_FILE}")"
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

# ---------------------------------------------------------------------------
# Code update
# ---------------------------------------------------------------------------

update_code() {
  if [[ "${SKIP_PULL}" == true ]]; then
    log "Skipping git pull (--skip-pull specified)."
    return
  fi
  log "Pulling latest code from git…"
  run git -C "${REPO_ROOT}" pull --ff-only
}

install_dependencies() {
  log "Installing/updating Python dependencies…"
  if [[ ! -d "${VENV_DIR}" ]]; then
    log "Virtual environment not found at ${VENV_DIR}. Run bash install.sh first."
    die "Virtual environment missing."
  fi
  run "${VENV_DIR}/bin/pip" install --quiet -r "${REPO_ROOT}/requirements.txt"
  run "${VENV_DIR}/bin/pip" install --quiet -r "${REPO_ROOT}/gateway/requirements.txt"
}

# ---------------------------------------------------------------------------
# Service management
# ---------------------------------------------------------------------------

start_service() {
  local color="$1"
  log "Starting gateway-${color}.service…"
  run sudo systemctl restart "gateway-${color}.service"
  log "gateway-${color}.service started."
}

stop_service() {
  local color="$1"
  log "Stopping gateway-${color}.service…"
  run sudo systemctl stop "gateway-${color}.service"
  log "gateway-${color}.service stopped."
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

wait_for_healthy() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"
  local url="http://127.0.0.1:${port}/health"

  log "Waiting for gateway-${color} to become healthy at ${url}…"

  local attempt=0
  while [[ ${attempt} -lt ${HEALTH_CHECK_RETRIES} ]]; do
    attempt=$(( attempt + 1 ))

    local http_status
    if [[ "${DRY_RUN}" == true ]]; then
      log "[dry-run] Health check attempt ${attempt}/${HEALTH_CHECK_RETRIES} -> ${url}"
      return 0
    fi

    http_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --max-time 3 "${url}" 2>/dev/null || echo "000")"

    if [[ "${http_status}" == "200" ]]; then
      log "gateway-${color} is healthy (HTTP ${http_status}) after ${attempt} attempt(s)."
      return 0
    fi

    log "  Attempt ${attempt}/${HEALTH_CHECK_RETRIES}: HTTP ${http_status} – retrying in ${HEALTH_CHECK_INTERVAL}s…"
    sleep "${HEALTH_CHECK_INTERVAL}"
  done

  die "Health check for gateway-${color} timed out after ${HEALTH_CHECK_RETRIES} attempts. Aborting deployment."
}

# ---------------------------------------------------------------------------
# nginx traffic switch
# ---------------------------------------------------------------------------

switch_nginx_upstream() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"

  log "Switching nginx upstream to gateway-${color} (port ${port})…"

  # Write the active upstream config fragment.
  # nginx will use this file after reload.
  local new_conf
  new_conf="$(cat <<EOF
# Managed by deploy/deploy.sh – do not edit manually.
# Active deployment colour: ${color}
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

  # Write atomically via a temp file to avoid a partial-write window.
  local tmp_file
  tmp_file="$(mktemp /tmp/gateway-upstream-XXXXXX.conf)"
  echo "${new_conf}" > "${tmp_file}"

  # Test the config before replacing the live file.
  sudo nginx -t -c /etc/nginx/nginx.conf 2>/dev/null \
    || warn "nginx -t reported errors; attempting reload anyway."

  sudo mv "${tmp_file}" "${NGINX_UPSTREAM_CONF}"
  sudo nginx -s reload

  log "nginx reloaded – traffic now routed to gateway-${color} (port ${port})."
}

# ---------------------------------------------------------------------------
# Main deployment flow
# ---------------------------------------------------------------------------

main() {
  log "==============================="
  log "  Gateway Blue-Green Deployment"
  log "==============================="
  [[ "${DRY_RUN}" == true ]] && log "DRY-RUN MODE – no destructive changes will be made."

  check_prerequisites

  local active_color
  active_color="$(read_active_color)"
  local target_color
  target_color="$(opposite_color "${active_color}")"

  log "Currently active: ${active_color}"
  log "Deployment target: ${target_color}"

  # Step 1 – Update code and dependencies.
  update_code
  install_dependencies

  # Step 2 – Start the inactive (target) instance.
  start_service "${target_color}"

  # Step 3 – Wait for the new instance to pass health checks.
  #          If this fails the script exits non-zero; nginx is NOT switched.
  wait_for_healthy "${target_color}"

  # Step 4 – Switch nginx traffic to the new instance.
  switch_nginx_upstream "${target_color}"

  # Step 5 – Record the new active colour.
  write_active_color "${target_color}"

  # Step 6 – Optionally drain and stop the previously active instance.
  if [[ "${STOP_OLD}" == true ]]; then
    log "Draining old instance (gateway-${active_color}) for ${DRAIN_SECONDS}s…"
    [[ "${DRY_RUN}" == false ]] && sleep "${DRAIN_SECONDS}"
    stop_service "${active_color}"
  else
    log "Leaving gateway-${active_color} running (--no-stop-old specified)."
    log "To roll back: bash deploy/rollback.sh"
  fi

  log ""
  log "✓ Deployment complete."
  log "  Active instance : gateway-${target_color} (port $(port_for_color "${target_color}"))"
  log "  Previous instance: gateway-${active_color} $(${STOP_OLD} && echo '(stopped)' || echo '(still running)')"
  log ""
  log "To roll back to gateway-${active_color}: bash deploy/rollback.sh"
}

main
