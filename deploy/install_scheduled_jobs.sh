#!/usr/bin/env bash
# =============================================================================
# deploy/install_scheduled_jobs.sh – Install managed systemd timers from source.
#
# USAGE
#   bash deploy/install_scheduled_jobs.sh [--dry-run] [--target-dir /etc/systemd/system]
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="${REPO_ROOT}/ops/systemd/timers"
TARGET_DIR="/etc/systemd/system"
DRY_RUN=false

if [[ -x "${REPO_ROOT}/.venv/bin/python3" ]]; then
  PYTHON_BIN="${REPO_ROOT}/.venv/bin/python3"
else
  PYTHON_BIN="$(command -v python3)"
fi

render_template() {
  local template_path="$1"
  sed \
    -e "s|__REPO_ROOT__|${REPO_ROOT}|g" \
    -e "s|__PYTHON__|${PYTHON_BIN}|g" \
    "${template_path}"
}

run() {
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --target-dir) TARGET_DIR="${2:?--target-dir requires a value}"; shift ;;
    -h|--help)
      sed -n '/^# USAGE/,/^# =============================================================================$/{ /^# \{0,2\}/p; }' "${BASH_SOURCE[0]}" \
        | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

[[ -d "${TEMPLATE_DIR}" ]] || { echo "Template directory not found: ${TEMPLATE_DIR}" >&2; exit 1; }

shopt -s nullglob
templates=("${TEMPLATE_DIR}"/*.service "${TEMPLATE_DIR}"/*.timer)
shopt -u nullglob

[[ ${#templates[@]} -gt 0 ]] || { echo "No timer templates found in ${TEMPLATE_DIR}" >&2; exit 1; }

for template in "${templates[@]}"; do
  unit_name="$(basename "${template}")"
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] Would install ${unit_name} to ${TARGET_DIR}/${unit_name}"
    render_template "${template}"
    echo ""
    continue
  fi

  tmp_file="$(mktemp "/tmp/${unit_name}.XXXXXX")"
  render_template "${template}" > "${tmp_file}"
  sudo install -m 0644 "${tmp_file}" "${TARGET_DIR}/${unit_name}"
  rm -f "${tmp_file}"
done

timer_units=()
for template in "${TEMPLATE_DIR}"/*.timer; do
  timer_units+=("$(basename "${template}")")
done

if [[ "${DRY_RUN}" == true ]]; then
  echo "[dry-run] Would run: sudo systemctl daemon-reload"
  if [[ ${#timer_units[@]} -gt 0 ]]; then
    echo "[dry-run] Would run: sudo systemctl enable --now ${timer_units[*]}"
  fi
  exit 0
fi

run sudo systemctl daemon-reload
if [[ ${#timer_units[@]} -gt 0 ]]; then
  run sudo systemctl enable --now "${timer_units[@]}"
fi

echo "Installed systemd timers: ${timer_units[*]}"

