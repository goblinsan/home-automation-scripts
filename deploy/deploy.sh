#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh – Docker-based blue-green deployment script for the gateway.
#
# WHAT IT DOES
#   1. Reads the currently active deployment color (blue or green) from the
#      state file.
#   2. Identifies the inactive color as the deployment target.
#   3. Optionally pulls the latest code from git.
#   4. Builds the gateway Docker image for the inactive slot tag.
#   5. Restarts the inactive slot's systemd unit so it runs the new image.
#   6. Polls the inactive instance's /health endpoint until it responds.
#   7. Switches nginx to the newly healthy slot.
#   8. Verifies the /health endpoint through nginx.
#   9. Writes the new active color to the state file.
#  10. Optionally stops the previously active slot after a drain delay.
#
# USAGE
#   bash deploy/deploy.sh [OPTIONS]
#
# OPTIONS
#   --no-stop-old      Keep the previously active slot running after cutover.
#   --drain-seconds N  Seconds to wait before stopping the old slot. Default: 10.
#   --skip-pull        Skip 'git pull'; deploy from the current working tree.
#   --skip-build       Skip 'docker build'; restart using the current slot tag.
#   --dry-run          Print the steps without making changes.
#   -h, --help         Show this help text and exit.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="/var/lib/home-automation/active_color"
NGINX_UPSTREAM_CONF="/etc/nginx/conf.d/gateway-active-upstream.conf"
DOCKERFILE="${REPO_ROOT}/gateway/Dockerfile"
SMOKE_TEST_SCRIPT="${REPO_ROOT}/deploy/smoke_test.sh"
INSTALL_SCHEDULED_JOBS_SCRIPT="${REPO_ROOT}/deploy/install_scheduled_jobs.sh"
LOCK_FILE="/tmp/home-automation-gateway-deploy.lock"
IMAGE_REPO="home-automation-gateway"
BLUE_PORT=8081
GREEN_PORT=8082
HEALTH_CHECK_RETRIES=30
HEALTH_CHECK_INTERVAL=2
PROXY_HEALTH_URL="http://127.0.0.1/health"

STOP_OLD=true
DRAIN_SECONDS=10
SKIP_PULL=false
SKIP_BUILD=false
DRY_RUN=false

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
  sed -n '/^# USAGE/,/^# =============================================================================$/{ /^# \{0,2\}/p; }' "${BASH_SOURCE[0]}" \
    | sed 's/^# \{0,2\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-stop-old)    STOP_OLD=false ;;
    --drain-seconds)  DRAIN_SECONDS="${2:?--drain-seconds requires a value}"; shift ;;
    --skip-pull)      SKIP_PULL=true ;;
    --skip-build)     SKIP_BUILD=true ;;
    --dry-run)        DRY_RUN=true ;;
    -h|--help)        show_help ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

check_prerequisites() {
  log "Checking prerequisites..."

  command -v curl >/dev/null 2>&1 || die "curl is required but not found."
  command -v docker >/dev/null 2>&1 || die "docker is required but not found."
  command -v flock >/dev/null 2>&1 || die "flock is required but not found."
  command -v nginx >/dev/null 2>&1 || die "nginx is required but not found."
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required but not found."
  [[ -f "${DOCKERFILE}" ]] || die "Dockerfile not found: ${DOCKERFILE}"
  [[ -x "${SMOKE_TEST_SCRIPT}" ]] || die "Smoke test script is missing or not executable: ${SMOKE_TEST_SCRIPT}"
  [[ -x "${INSTALL_SCHEDULED_JOBS_SCRIPT}" ]] || die "Scheduled job installer is missing or not executable: ${INSTALL_SCHEDULED_JOBS_SCRIPT}"

  for svc in gateway-blue gateway-green; do
    systemctl list-unit-files "${svc}.service" >/dev/null 2>&1 \
      || die "systemd unit ${svc}.service is not installed. See ops/systemd/."
  done

  log "Prerequisites OK."
}

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
  echo "blue"
}

write_active_color() {
  local color="$1"
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] printf '%s\n' '${color}' | sudo tee '${STATE_FILE}' >/dev/null"
    return
  fi

  sudo mkdir -p "$(dirname "${STATE_FILE}")"
  printf '%s\n' "${color}" | sudo tee "${STATE_FILE}" >/dev/null
  log "State file updated: active color is now '${color}'."
}

opposite_color() {
  [[ "$1" == "blue" ]] && echo "green" || echo "blue"
}

port_for_color() {
  [[ "$1" == "blue" ]] && echo "${BLUE_PORT}" || echo "${GREEN_PORT}"
}

image_for_color() {
  echo "${IMAGE_REPO}:$1"
}

update_code() {
  if [[ "${SKIP_PULL}" == true ]]; then
    log "Skipping git pull (--skip-pull specified)."
    return
  fi

  log "Pulling latest code from git..."
  run git -C "${REPO_ROOT}" pull --ff-only
}

build_image() {
  local color="$1"
  local image
  image="$(image_for_color "${color}")"

  if [[ "${SKIP_BUILD}" == true ]]; then
    log "Skipping docker build for ${image} (--skip-build specified)."
    return
  fi

  log "Building Docker image ${image}..."
  run docker build -t "${image}" -f "${DOCKERFILE}" "${REPO_ROOT}"
}

start_service() {
  local color="$1"
  log "Restarting gateway-${color}.service..."
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

  die "Health check for gateway-${color} timed out after ${HEALTH_CHECK_RETRIES} attempts."
}

switch_nginx_upstream() {
  local color="$1"
  local port
  port="$(port_for_color "${color}")"

  log "Switching nginx upstream to gateway-${color} (port ${port})..."

  local new_conf
  new_conf="$(cat <<EOF
# Managed by deploy/deploy.sh – do not edit manually.
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

  log "nginx reloaded – traffic now routed to gateway-${color} (port ${port})."
}

verify_proxy_health() {
  local color="$1"

  if [[ "${DRY_RUN}" == true ]]; then
    log "[dry-run] Proxy smoke test -> ${PROXY_HEALTH_URL}"
    return 0
  fi

  log "Verifying gateway health through nginx at ${PROXY_HEALTH_URL}..."
  "${SMOKE_TEST_SCRIPT}" --url "${PROXY_HEALTH_URL}" --expect-color "${color}"
}

install_scheduled_jobs() {
  log "Installing managed systemd timers from source control..."

  if [[ "${DRY_RUN}" == true ]]; then
    log "[dry-run] Scheduled job install -> ${INSTALL_SCHEDULED_JOBS_SCRIPT}"
    return 0
  fi

  "${INSTALL_SCHEDULED_JOBS_SCRIPT}"
}

main() {
  log "==============================="
  log "  Gateway Blue-Green Deployment"
  log "==============================="
  [[ "${DRY_RUN}" == true ]] && log "DRY-RUN MODE – no destructive changes will be made."

  check_prerequisites
  acquire_lock

  local active_color
  active_color="$(read_active_color)"
  local target_color
  target_color="$(opposite_color "${active_color}")"

  log "Currently active: ${active_color}"
  log "Deployment target: ${target_color}"

  update_code
  build_image "${target_color}"
  start_service "${target_color}"
  wait_for_healthy "${target_color}"
  switch_nginx_upstream "${target_color}"

  if ! verify_proxy_health "${target_color}"; then
    warn "Proxy smoke test failed after switching traffic; restoring nginx to gateway-${active_color}."
    switch_nginx_upstream "${active_color}"
    die "Proxy smoke test failed after cutover."
  fi

  install_scheduled_jobs
  write_active_color "${target_color}"

  if [[ "${STOP_OLD}" == true ]]; then
    log "Draining old slot (gateway-${active_color}) for ${DRAIN_SECONDS}s..."
    [[ "${DRY_RUN}" == false ]] && sleep "${DRAIN_SECONDS}"
    stop_service "${active_color}"
  else
    log "Leaving gateway-${active_color} running (--no-stop-old specified)."
  fi

  log ""
  log "Deployment complete."
  log "  Active slot : gateway-${target_color} ($(image_for_color "${target_color}"))"
  log "  Previous slot: gateway-${active_color} $(${STOP_OLD} && echo '(stopped)' || echo '(still running)')"
}

main
