#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# setup-node.sh — Interactive wizard for bootstrapping a new worker node
#
# Connects with your personal sudo-capable user, then:
#   1. Creates the "deploy" user (with Docker and sudoers access)
#   2. Installs your SSH key for key-based auth as deploy
#   3. Installs Docker Engine + Compose plugin if missing
#   4. Creates the gateway workload directory structure
#   5. Verifies connectivity from the control-plane as deploy
#   6. Outputs a workerNode config block for gateway.config.json
# ──────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── colors ────────────────────────────────────────────────────────────────────
bold='\033[1m'
dim='\033[2m'
green='\033[0;32m'
yellow='\033[0;33m'
red='\033[0;31m'
cyan='\033[0;36m'
reset='\033[0m'

info()  { echo -e "${cyan}→${reset} $*"; }
ok()    { echo -e "${green}✓${reset} $*"; }
warn()  { echo -e "${yellow}⚠${reset} $*"; }
fail()  { echo -e "${red}✗${reset} $*" >&2; }
step()  { echo -e "\n${bold}── $* ──${reset}"; }

prompt_value() {
  local label="$1" default="$2" var_name="$3"
  local input
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${cyan}?${reset} ${label} ${dim}[${default}]${reset}: ")" input
    eval "$var_name=\"\${input:-$default}\""
  else
    while true; do
      read -rp "$(echo -e "${cyan}?${reset} ${label}: ")" input
      if [[ -n "$input" ]]; then
        eval "$var_name=\"$input\""
        return
      fi
      fail "This value is required."
    done
  fi
}

prompt_choice() {
  local label="$1"
  shift
  local -a options=("$@")
  echo -e "\n${cyan}?${reset} ${label}"
  for i in "${!options[@]}"; do
    echo -e "  ${bold}$((i + 1)))${reset} ${options[$i]}"
  done
  local choice
  while true; do
    read -rp "$(echo -e "${cyan}?${reset} Choose [1-${#options[@]}]: ")" choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
      CHOICE_INDEX=$((choice - 1))
      return
    fi
    fail "Enter a number between 1 and ${#options[@]}."
  done
}

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${bold}╔══════════════════════════════════════════════════════╗${reset}"
echo -e "${bold}║     Gateway Control Plane — New Node Setup Wizard   ║${reset}"
echo -e "${bold}╚══════════════════════════════════════════════════════╝${reset}"
echo ""
echo -e "${dim}This wizard will configure a remote machine so the control-plane"
echo -e "can manage it as a worker node via the 'deploy' user.${reset}"
echo ""

# ── step 1: collect information ───────────────────────────────────────────────
step "Step 1: Node Information"

prompt_value "Node hostname or IP address" "" NODE_HOST
prompt_value "Node ID (short name, e.g. core-node, gpu-01, pi-edge)" "" NODE_ID
prompt_value "SSH port for this node" "22" SSH_PORT

echo ""
prompt_choice "Node type preset" \
  "General Linux Node  — standard Docker worker" \
  "GPU Compute Node    — Docker + NVIDIA, suited for LLM/STT/CV" \
  "Raspberry Pi Edge   — lighter edge node for proxy-style services" \
  "Custom              — I'll set paths manually"

NODE_TYPE=$CHOICE_INDEX

case $NODE_TYPE in
  0)
    DEFAULT_BUILD_ROOT="/srv/gateway-workloads/builds"
    DEFAULT_STACK_ROOT="/srv/gateway-workloads/stacks"
    DEFAULT_VOLUME_ROOT="/srv/gateway-workloads/volumes"
    NODE_DESC="Standard Docker worker node"
    POLL_INTERVAL=15
    ;;
  1)
    DEFAULT_BUILD_ROOT="/data/docker/builds/gateway-workloads"
    DEFAULT_STACK_ROOT="/data/docker/stacks/gateway-workloads"
    DEFAULT_VOLUME_ROOT="/data/docker/volumes/gateway-workloads"
    NODE_DESC="Docker + NVIDIA GPU worker for LLM/STT/CV APIs"
    POLL_INTERVAL=15
    ;;
  2)
    DEFAULT_BUILD_ROOT="/opt/gateway-control-plane"
    DEFAULT_STACK_ROOT="/opt/gateway-control-plane/stacks"
    DEFAULT_VOLUME_ROOT="/opt/gateway-control-plane/volumes"
    NODE_DESC="Raspberry Pi edge node"
    POLL_INTERVAL=30
    ;;
  3)
    DEFAULT_BUILD_ROOT=""
    DEFAULT_STACK_ROOT=""
    DEFAULT_VOLUME_ROOT=""
    NODE_DESC=""
    POLL_INTERVAL=15
    ;;
esac

prompt_value "Build root (cloned repos)"   "$DEFAULT_BUILD_ROOT"  BUILD_ROOT
prompt_value "Stack root (compose projects)" "$DEFAULT_STACK_ROOT" STACK_ROOT
prompt_value "Volume root (persistent data)" "$DEFAULT_VOLUME_ROOT" VOLUME_ROOT
prompt_value "Node description"             "$NODE_DESC"          NODE_DESC
prompt_value "Worker poll interval (seconds)" "$POLL_INTERVAL"    POLL_INTERVAL

# ── step 2: initial connection details ────────────────────────────────────────
step "Step 2: Initial SSH Connection"

echo -e "${dim}We'll connect as your personal sudo-capable user to set things up.${reset}"
prompt_value "Your SSH username on the target" "$USER" ADMIN_USER

SSH_PUBKEY_PATH="${HOME}/.ssh/id_ed25519.pub"
prompt_value "SSH public key to authorize for deploy user" "$SSH_PUBKEY_PATH" SSH_PUBKEY_PATH

if [[ ! -f "$SSH_PUBKEY_PATH" ]]; then
  fail "Public key not found at ${SSH_PUBKEY_PATH}"
  exit 1
fi

SSH_PUBKEY="$(cat "$SSH_PUBKEY_PATH")"
ok "Using public key: ${SSH_PUBKEY_PATH}"

# ── step 3: confirm plan ─────────────────────────────────────────────────────
step "Step 3: Review & Confirm"

echo ""
echo -e "  ${bold}Node ID:${reset}         $NODE_ID"
echo -e "  ${bold}Host:${reset}            $NODE_HOST"
echo -e "  ${bold}SSH port:${reset}        $SSH_PORT"
echo -e "  ${bold}Admin user:${reset}      $ADMIN_USER"
echo -e "  ${bold}Deploy user:${reset}     deploy"
echo -e "  ${bold}Build root:${reset}      $BUILD_ROOT"
echo -e "  ${bold}Stack root:${reset}      $STACK_ROOT"
echo -e "  ${bold}Volume root:${reset}     $VOLUME_ROOT"
echo -e "  ${bold}Description:${reset}     $NODE_DESC"
echo -e "  ${bold}Poll interval:${reset}   ${POLL_INTERVAL}s"
echo ""
echo -e "  ${bold}Actions on target:${reset}"
echo -e "    1. Create 'deploy' user with Docker and limited sudo access"
echo -e "    2. Install SSH public key for key-based auth"
echo -e "    3. Install Docker Engine + Compose plugin (if missing)"
echo -e "    4. Create directory structure"
echo -e "    5. Verify control-plane connectivity as 'deploy'"
echo ""

read -rp "$(echo -e "${cyan}?${reset} Proceed? ${dim}[y/N]${reset} ")" CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
  info "Aborted."
  exit 0
fi

# ── helper: run command on target via admin user ──────────────────────────────
ssh_admin() {
  ssh -p "$SSH_PORT" \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    "${ADMIN_USER}@${NODE_HOST}" \
    "$@"
}

ssh_deploy() {
  ssh -p "$SSH_PORT" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    "deploy@${NODE_HOST}" \
    "$@"
}

# ── step 4: test connectivity ────────────────────────────────────────────────
step "Step 4: Testing connectivity as ${ADMIN_USER}"

if ! ssh_admin "echo ok" >/dev/null 2>&1; then
  fail "Cannot connect to ${ADMIN_USER}@${NODE_HOST}:${SSH_PORT}"
  fail "Make sure you can SSH to this host and try again."
  exit 1
fi
ok "Connected to ${NODE_HOST} as ${ADMIN_USER}"

# Detect OS family for package manager
OS_FAMILY=$(ssh_admin "cat /etc/os-release 2>/dev/null | grep -w ID | head -1 | cut -d= -f2 | tr -d '\"'" || echo "unknown")
info "Detected OS: ${OS_FAMILY}"

# ── step 5: create deploy user ───────────────────────────────────────────────
step "Step 5: Creating 'deploy' user"

ssh_admin "bash -s" <<'REMOTE_USER_SETUP'
set -euo pipefail

if id deploy &>/dev/null; then
  echo "EXISTING: deploy user already exists"
else
  sudo useradd -m -s /bin/bash deploy
  echo "CREATED: deploy user"
fi

# Ensure deploy is in the docker group (created later if Docker isn't installed yet)
if getent group docker &>/dev/null; then
  sudo usermod -aG docker deploy
  echo "DOCKER_GROUP: added deploy to docker group"
else
  echo "DOCKER_GROUP: docker group does not exist yet (will add after Docker install)"
fi

# Limited sudoers for systemd operations (same pattern as existing nodes)
SUDOERS_FILE="/etc/sudoers.d/deploy-gateway"
if [[ ! -f "$SUDOERS_FILE" ]]; then
  sudo tee "$SUDOERS_FILE" > /dev/null <<'SUDOERS'
# Gateway control-plane: allow deploy user to manage systemd units
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable *
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl disable *
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl start *
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop *
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart *
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl status *
SUDOERS
  sudo chmod 0440 "$SUDOERS_FILE"
  echo "SUDOERS: created ${SUDOERS_FILE}"
else
  echo "SUDOERS: ${SUDOERS_FILE} already exists"
fi
REMOTE_USER_SETUP

ok "deploy user is configured"

# ── step 6: install SSH key ──────────────────────────────────────────────────
step "Step 6: Installing SSH key for deploy"

ssh_admin "bash -s" <<REMOTE_KEY_SETUP
set -euo pipefail

DEPLOY_SSH_DIR="/home/deploy/.ssh"
AUTHORIZED_KEYS="\${DEPLOY_SSH_DIR}/authorized_keys"

sudo mkdir -p "\${DEPLOY_SSH_DIR}"

# Append key only if not already present
PUBKEY='${SSH_PUBKEY}'
if sudo test -f "\${AUTHORIZED_KEYS}" && sudo grep -qF "\${PUBKEY}" "\${AUTHORIZED_KEYS}"; then
  echo "KEY: already authorized"
else
  echo "\${PUBKEY}" | sudo tee -a "\${AUTHORIZED_KEYS}" > /dev/null
  echo "KEY: authorized"
fi

sudo chmod 700 "\${DEPLOY_SSH_DIR}"
sudo chmod 600 "\${AUTHORIZED_KEYS}"
sudo chown -R deploy:deploy "\${DEPLOY_SSH_DIR}"
REMOTE_KEY_SETUP

ok "SSH key installed for deploy"

# ── step 7: install Docker ───────────────────────────────────────────────────
step "Step 7: Docker Engine + Compose"

DOCKER_INSTALLED=$(ssh_admin "command -v docker &>/dev/null && echo yes || echo no")

if [[ "$DOCKER_INSTALLED" == "yes" ]]; then
  DOCKER_VERSION=$(ssh_admin "docker --version" 2>/dev/null || echo "unknown")
  ok "Docker already installed: ${DOCKER_VERSION}"
else
  info "Installing Docker Engine..."

  ssh_admin "bash -s" <<'REMOTE_DOCKER_INSTALL'
set -euo pipefail

# Install via official convenience script (supports Debian, Ubuntu, Raspbian, Fedora, etc.)
curl -fsSL https://get.docker.com | sudo sh

# Enable and start dockerd
sudo systemctl enable --now docker

# Add deploy to docker group now that it exists
sudo usermod -aG docker deploy

echo "DOCKER: installed and started"
REMOTE_DOCKER_INSTALL

  ok "Docker installed"
fi

# Verify compose plugin
COMPOSE_OK=$(ssh_admin "docker compose version &>/dev/null && echo yes || echo no")
if [[ "$COMPOSE_OK" == "yes" ]]; then
  COMPOSE_VERSION=$(ssh_admin "docker compose version" 2>/dev/null || echo "unknown")
  ok "Docker Compose available: ${COMPOSE_VERSION}"
else
  warn "Docker Compose plugin not detected. You may need to install it manually."
fi

# Ensure deploy is in docker group (may need a re-check after install)
ssh_admin "sudo usermod -aG docker deploy" 2>/dev/null || true

# ── step 8: GPU setup hint ───────────────────────────────────────────────────
if [[ "$NODE_TYPE" == "1" ]]; then
  step "GPU Node Note"
  warn "This is a GPU node. You'll need to install the NVIDIA Container Toolkit separately:"
  echo -e "  ${dim}https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html${reset}"
  echo -e "  ${dim}After installing, restart Docker: sudo systemctl restart docker${reset}"
  echo ""
fi

# ── step 9: create directory structure ────────────────────────────────────────
step "Step 8: Creating directory structure"

ssh_admin "bash -s" <<REMOTE_DIRS
set -euo pipefail

for dir in "${BUILD_ROOT}" "${STACK_ROOT}" "${VOLUME_ROOT}"; do
  if [[ -d "\$dir" ]]; then
    echo "EXISTS: \$dir"
  else
    sudo mkdir -p "\$dir"
    echo "CREATED: \$dir"
  fi
  sudo chown deploy:deploy "\$dir"
done
REMOTE_DIRS

ok "Directory structure ready"

# ── step 10: verify deploy connectivity ──────────────────────────────────────
step "Step 9: Verifying control-plane connectivity as deploy"

if ssh_deploy "echo ok" >/dev/null 2>&1; then
  ok "SSH as deploy@${NODE_HOST}:${SSH_PORT} — working"
else
  fail "Cannot connect as deploy@${NODE_HOST}:${SSH_PORT} with BatchMode=yes"
  fail "Check that the SSH key is correctly authorized."
  exit 1
fi

# Verify Docker access as deploy
DOCKER_DEPLOY_OK=$(ssh_deploy "docker info &>/dev/null && echo yes || echo no")
if [[ "$DOCKER_DEPLOY_OK" == "yes" ]]; then
  ok "deploy user has Docker access"
else
  warn "deploy user cannot run Docker yet (group membership may require a re-login)"
  warn "Try: ssh deploy@${NODE_HOST} -p ${SSH_PORT} 'newgrp docker && docker info'"
fi

# ── step 10: output config block ─────────────────────────────────────────────
step "Step 10: Configuration"

CONFIG_BLOCK=$(cat <<EOF
{
  "id": "${NODE_ID}",
  "enabled": true,
  "description": "${NODE_DESC}",
  "host": "${NODE_HOST}",
  "sshUser": "deploy",
  "sshPort": ${SSH_PORT},
  "buildRoot": "${BUILD_ROOT}",
  "stackRoot": "${STACK_ROOT}",
  "volumeRoot": "${VOLUME_ROOT}",
  "workerPollIntervalSeconds": ${POLL_INTERVAL},
  "dockerCommand": "docker",
  "dockerComposeCommand": "docker compose"
}
EOF
)

echo ""
echo -e "${bold}Add this to the workerNodes array in your gateway.config.json:${reset}"
echo ""
echo -e "${dim}${CONFIG_BLOCK}${reset}"
echo ""

# Offer to append to config automatically
CONFIG_PATH="${REPO_ROOT}/configs/gateway.config.json"
if [[ -f "$CONFIG_PATH" ]]; then
  read -rp "$(echo -e "${cyan}?${reset} Append this node to ${dim}configs/gateway.config.json${reset}? ${dim}[y/N]${reset} ")" AUTO_ADD
  if [[ "$AUTO_ADD" =~ ^[Yy] ]]; then
    # Use node to safely insert into the JSON array
    node -e "
      const fs = require('fs');
      const path = '${CONFIG_PATH}';
      const config = JSON.parse(fs.readFileSync(path, 'utf8'));
      const newNode = ${CONFIG_BLOCK};
      if (!config.workerNodes) config.workerNodes = [];
      const existing = config.workerNodes.findIndex(n => n.id === newNode.id);
      if (existing >= 0) {
        console.log('Replacing existing node entry for ' + newNode.id);
        config.workerNodes[existing] = newNode;
      } else {
        config.workerNodes.push(newNode);
      }
      fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
      console.log('Updated ' + path);
    "
    ok "Node added to gateway.config.json"
  fi
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${bold}╔══════════════════════════════════════════════════════╗${reset}"
echo -e "${bold}║                    Setup Complete                   ║${reset}"
echo -e "${bold}╚══════════════════════════════════════════════════════╝${reset}"
echo ""
echo -e "  ${green}✓${reset} deploy user created with SSH key auth"
echo -e "  ${green}✓${reset} Docker Engine available"
echo -e "  ${green}✓${reset} Directory structure ready"
echo -e "  ${green}✓${reset} Control-plane can connect as deploy@${NODE_HOST}"
echo ""
echo -e "  ${bold}Next steps:${reset}"
echo -e "  1. Add workloads targeting ${bold}${NODE_ID}${reset} in your config"
echo -e "  2. Run ${dim}node src/cli.ts build --config configs/gateway.config.json --out generated${reset}"
echo -e "  3. Deploy with ${dim}node src/cli.ts deploy-remote-workload --config configs/gateway.config.json --workload <id>${reset}"
echo ""
