#!/usr/bin/env bash
# =============================================================================
# install.sh – Bootstrap script for home-automation-scripts
#
# What it does:
#   1. Detects the system package manager and installs required system packages.
#   2. Creates local runtime directories (secrets/, logs/).
#   3. Creates a Python virtual environment (.venv/).
#   4. Installs Python dependencies listed in requirements.txt.
#
# Usage:
#   bash install.sh [--dry-run]
#
# Options:
#   --dry-run   Print the steps that would be executed without making changes.
#
# Notes:
#   - Supported distros: Debian/Ubuntu (apt), Fedora/RHEL/CentOS (dnf/yum),
#     Arch Linux (pacman).
#   - Run as a regular user; sudo is invoked automatically where needed.
#   - The script is idempotent: running it a second time is safe.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${REPO_ROOT}/.venv"
REQUIREMENTS="${REPO_ROOT}/requirements.txt"

log()  { echo "[install] $*"; }
warn() { echo "[install] WARNING: $*" >&2; }
run()  {
  if [[ "${DRY_RUN}" == true ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# System dependency installation
# ---------------------------------------------------------------------------

# Packages required on the host system.
# python3-venv supplies the 'venv' module on Debian/Ubuntu where it is split
# into a separate package from the main python3 install.
APT_PACKAGES=(git python3 python3-pip python3-venv cron jq curl wget)
DNF_PACKAGES=(git python3 python3-pip cronie jq curl wget)
PACMAN_PACKAGES=(git python python-pip cronie jq curl wget)

detect_pkg_manager() {
  if command -v apt-get &>/dev/null; then
    echo "apt"
  elif command -v dnf &>/dev/null; then
    echo "dnf"
  elif command -v yum &>/dev/null; then
    echo "yum"
  elif command -v pacman &>/dev/null; then
    echo "pacman"
  else
    echo "unknown"
  fi
}

install_system_deps() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_manager)"
  log "Detected package manager: ${pkg_mgr}"

  case "${pkg_mgr}" in
    apt)
      log "Updating apt package index..."
      run sudo apt-get update -qq
      log "Installing packages: ${APT_PACKAGES[*]}"
      run sudo apt-get install -y "${APT_PACKAGES[@]}"
      ;;
    dnf)
      log "Installing packages: ${DNF_PACKAGES[*]}"
      run sudo dnf install -y "${DNF_PACKAGES[@]}"
      ;;
    yum)
      log "Installing packages: ${DNF_PACKAGES[*]}"
      run sudo yum install -y "${DNF_PACKAGES[@]}"
      ;;
    pacman)
      log "Installing packages: ${PACMAN_PACKAGES[*]}"
      run sudo pacman -Sy --noconfirm "${PACMAN_PACKAGES[@]}"
      ;;
    *)
      warn "Unrecognized package manager. Please install the following manually:"
      warn "  git, python3, pip, python3-venv, cron, jq, curl, wget"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Local directory setup
# ---------------------------------------------------------------------------

create_local_dirs() {
  local dirs=("${REPO_ROOT}/secrets" "${REPO_ROOT}/logs")
  for dir in "${dirs[@]}"; do
    if [[ ! -d "${dir}" ]]; then
      log "Creating directory: ${dir}"
      run mkdir -p "${dir}"
    else
      log "Directory already exists, skipping: ${dir}"
    fi
  done
}

# ---------------------------------------------------------------------------
# Python virtual environment
# ---------------------------------------------------------------------------

setup_venv() {
  if [[ ! -d "${VENV_DIR}" ]]; then
    log "Creating Python virtual environment at ${VENV_DIR}..."
    run python3 -m venv "${VENV_DIR}"
  else
    log "Virtual environment already exists at ${VENV_DIR}, skipping creation."
  fi

  if [[ -f "${REQUIREMENTS}" ]]; then
    log "Installing Python packages from ${REQUIREMENTS}..."
    if [[ "${DRY_RUN}" == true ]]; then
      echo "[dry-run] ${VENV_DIR}/bin/pip install --upgrade pip"
      echo "[dry-run] ${VENV_DIR}/bin/pip install -r ${REQUIREMENTS}"
    else
      "${VENV_DIR}/bin/pip" install --upgrade pip --quiet
      "${VENV_DIR}/bin/pip" install -r "${REQUIREMENTS}" --quiet
    fi
  else
    log "No requirements.txt found, skipping Python package installation."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  log "=== home-automation-scripts installer ==="
  if [[ "${DRY_RUN}" == true ]]; then
    log "Running in DRY-RUN mode – no changes will be made."
  fi

  install_system_deps
  create_local_dirs
  setup_venv

  log ""
  log "=== Installation complete ==="
  log "Activate the virtual environment with:"
  log "  source ${VENV_DIR}/bin/activate"
  log ""
  log "Copy config templates to secrets/ and fill in your credentials:"
  log "  cp configs/*.example secrets/"
  log ""
  log "See docs/installation.md for the full post-install guide."
}

main
