# Blue-Green Deployment for the Gateway Service

This document describes how the **home-automation gateway** is deployed and
updated with minimal downtime using a blue-green deployment strategy.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [How Blue-Green Deployment Works](#how-blue-green-deployment-works)
4. [Initial Setup](#initial-setup)
5. [Deploying a New Version](#deploying-a-new-version)
6. [Verifying Health](#verifying-health)
7. [Rolling Back](#rolling-back)
8. [Credentials and Config Storage](#credentials-and-config-storage)
9. [Recovering from Partial Failure](#recovering-from-partial-failure)
10. [Operational Reference](#operational-reference)

---

## Architecture Overview

```
                         ┌──────────────────────────────────────┐
  External / LAN  ──────▶│        nginx  (port 80)              │
  requests               │  gateway-site.conf                   │
                         │  → includes active-upstream.conf     │
                         └──────────────┬───────────────────────┘
                                        │  proxy_pass
                              ┌─────────▼──────────┐
                              │  gateway_active     │  (upstream block)
                              │  127.0.0.1:<port>   │
                              └──────────┬──────────┘
                        ┌───────────────┴───────────────┐
                        │                               │
             ┌──────────▼──────────┐         ┌──────────▼──────────┐
             │   gateway-blue      │         │   gateway-green     │
             │   port 8081         │         │   port 8082         │
             │   (Flask/gunicorn)  │         │   (Flask/gunicorn)  │
             └──────────┬──────────┘         └──────────┬──────────┘
                        │                               │
                        └───────────────┬───────────────┘
                                        │  proxy_pass
                             ┌──────────▼──────────┐
                             │   Home Assistant     │
                             │   port 8123          │
                             └─────────────────────┘
```

At any given time **only one** gateway instance is live.  nginx routes all
traffic to it via the `gateway_active` upstream.  The other instance is either
stopped or idling—ready to become active at any moment.

### Components

| Component | Role |
|-----------|------|
| `gateway/app.py` | Flask app: proxies requests to Home Assistant, exposes `/health` |
| `ops/nginx/gateway-site.conf` | nginx virtual-host; forwards to `gateway_active` upstream |
| `/etc/nginx/conf.d/gateway-active-upstream.conf` | Active upstream pointer (managed by deploy script) |
| `ops/systemd/gateway-blue.service` | systemd unit for the blue instance (port 8081) |
| `ops/systemd/gateway-green.service` | systemd unit for the green instance (port 8082) |
| `/var/lib/home-automation/active_color` | State file: contains `blue` or `green` |
| `deploy/deploy.sh` | Blue-green deployment automation |
| `deploy/rollback.sh` | One-command rollback |

---

## Directory Structure

```
home-automation-scripts/
├── gateway/
│   ├── app.py                        # Gateway Flask application
│   └── requirements.txt              # Gateway Python dependencies
├── deploy/
│   ├── deploy.sh                     # Blue-green deployment script
│   └── rollback.sh                   # Rollback script
├── ops/
│   ├── nginx/
│   │   ├── gateway-site.conf         # nginx virtual-host config
│   │   ├── gateway-blue-upstream.conf   # Upstream def for blue (port 8081)
│   │   └── gateway-green-upstream.conf  # Upstream def for green (port 8082)
│   ├── systemd/
│   │   ├── gateway-blue.service      # systemd unit – blue instance
│   │   ├── gateway-green.service     # systemd unit – green instance
│   │   ├── gateway-blue.env.example  # Secret template for blue
│   │   └── gateway-green.env.example # Secret template for green
│   └── state/
│       └── README.md                 # Documents the runtime state file
└── docs/
    └── blue_green.md                 # This file
```

Runtime files **outside** the repository (never committed):

```
/etc/home-automation/
├── gateway-blue.env       # Secrets + config for blue (mode 600)
└── gateway-green.env      # Secrets + config for green (mode 600)

/var/lib/home-automation/
└── active_color           # Current active color: "blue" or "green"

/etc/nginx/conf.d/
└── gateway-active-upstream.conf   # Managed by deploy.sh / rollback.sh
```

---

## How Blue-Green Deployment Works

```
Before deployment:

  ACTIVE: blue (port 8081)   → nginx → traffic
  IDLE:   green (port 8082)  → not running

Deploy steps:

  1. Pull latest code.
  2. Start gateway-green.
  3. Poll GET http://127.0.0.1:8082/health until HTTP 200.
  4. Write gateway-green upstream to /etc/nginx/conf.d/gateway-active-upstream.conf.
  5. Run `nginx -s reload` (graceful, zero-drop).
  6. Update /var/lib/home-automation/active_color → "green".
  7. (Optional) Wait DRAIN_SECONDS, then stop gateway-blue.

After deployment:

  ACTIVE: green (port 8082)  → nginx → traffic
  IDLE:   blue (port 8081)   → stopped (or still running if --no-stop-old used)
```

The key safety property: **nginx is only reloaded after the new instance
passes health checks**.  If health checks never pass, the script exits with
code 1 and nginx continues routing to the old instance.

---

## Initial Setup

### 1. Create a system user

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin home-automation
```

### 2. Clone the repo to the server

```bash
sudo git clone https://github.com/goblinsan/home-automation-scripts.git \
    /opt/home-automation-scripts
sudo chown -R home-automation:home-automation /opt/home-automation-scripts
```

### 3. Run the bootstrap installer

```bash
cd /opt/home-automation-scripts
sudo bash install.sh
```

### 4. Install gateway Python dependencies

```bash
sudo -u home-automation /opt/home-automation-scripts/.venv/bin/pip install \
    -r /opt/home-automation-scripts/gateway/requirements.txt
```

### 5. Create environment files (secrets)

```bash
sudo mkdir -p /etc/home-automation

sudo cp ops/systemd/gateway-blue.env.example  /etc/home-automation/gateway-blue.env
sudo cp ops/systemd/gateway-green.env.example /etc/home-automation/gateway-green.env

# Fill in HA_URL, HA_TOKEN, and optionally GATEWAY_SECRET:
sudo nano /etc/home-automation/gateway-blue.env
sudo nano /etc/home-automation/gateway-green.env

# Restrict permissions so only root and the service user can read them:
sudo chmod 640 /etc/home-automation/gateway-blue.env \
                /etc/home-automation/gateway-green.env
sudo chown root:home-automation /etc/home-automation/gateway-blue.env \
                                 /etc/home-automation/gateway-green.env
```

### 6. Install systemd units

```bash
sudo cp ops/systemd/gateway-blue.service  /etc/systemd/system/
sudo cp ops/systemd/gateway-green.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gateway-blue.service gateway-green.service
```

### 7. Configure nginx

```bash
# Install the site config:
sudo cp ops/nginx/gateway-site.conf /etc/nginx/sites-available/gateway
sudo ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/gateway

# Install the initial upstream config (blue is active by default):
sudo mkdir -p /etc/nginx/conf.d
sudo cp ops/nginx/gateway-blue-upstream.conf \
    /etc/nginx/conf.d/gateway-active-upstream.conf

# Test and reload:
sudo nginx -t && sudo nginx -s reload
```

### 8. Start the initial instance and create the state file

```bash
sudo systemctl start gateway-blue.service
sudo mkdir -p /var/lib/home-automation
echo "blue" | sudo tee /var/lib/home-automation/active_color
```

### 9. Verify

```bash
curl http://127.0.0.1:8081/health   # direct check
curl http://gateway.home.local/health  # through nginx
```

---

## Deploying a New Version

Standard deployment (switches to inactive environment after health checks):

```bash
cd /opt/home-automation-scripts
bash deploy/deploy.sh
```

Keep the old instance running for fast rollback:

```bash
bash deploy/deploy.sh --no-stop-old
```

Preview what would happen without making changes:

```bash
bash deploy/deploy.sh --dry-run
```

### What the script does

1. Checks prerequisites (curl, nginx, systemctl, service units).
2. Reads the current active color from `/var/lib/home-automation/active_color`.
3. Determines the inactive color (the deployment target).
4. Runs `git pull --ff-only` to update the repo.
5. Installs/upgrades pip dependencies.
6. Runs `systemctl restart gateway-<target>.service`.
7. Polls `http://127.0.0.1:<port>/health` up to 30 times (60 s total).
8. Writes the new upstream config and reloads nginx.
9. Updates the state file.
10. Waits `DRAIN_SECONDS` (default 10) then stops the old instance.

If any step fails the script exits immediately with code 1.  nginx is **not**
switched until the health check passes.

---

## Verifying Health

Direct instance check (bypasses nginx):

```bash
curl -s http://127.0.0.1:8081/health | python3 -m json.tool   # blue
curl -s http://127.0.0.1:8082/health | python3 -m json.tool   # green
```

Through nginx:

```bash
curl -s http://gateway.home.local/health | python3 -m json.tool
```

Expected healthy response:

```json
{
  "color": "blue",
  "detail": "ha_status=200",
  "ha_reachable": true,
  "port": 8081,
  "status": "ok"
}
```

Check which color is active:

```bash
cat /var/lib/home-automation/active_color
```

Check service status:

```bash
systemctl status gateway-blue.service
systemctl status gateway-green.service
```

Check nginx upstream:

```bash
cat /etc/nginx/conf.d/gateway-active-upstream.conf
```

---

## Rolling Back

If a deployment causes problems, roll back to the other instance:

```bash
cd /opt/home-automation-scripts
bash deploy/rollback.sh
```

The rollback script:

1. Reads the current active color.
2. Starts the alternate instance if it is not already running.
3. Waits for health checks to pass.
4. Switches nginx back.
5. Updates the state file.
6. Stops the now-inactive instance.

**Rollback requires the old instance code to still be present** (i.e. git
has not been reset past that commit, and the `.venv` still has the old
dependencies installed).  For the fastest rollback, use `--no-stop-old`
during deployment.

Manual rollback (if scripts are unavailable):

```bash
# 1. Switch nginx upstream manually:
sudo cp ops/nginx/gateway-blue-upstream.conf \
    /etc/nginx/conf.d/gateway-active-upstream.conf
sudo nginx -s reload

# 2. Update state file:
echo "blue" | sudo tee /var/lib/home-automation/active_color

# 3. Ensure blue is running:
sudo systemctl start gateway-blue.service

# 4. Stop green if desired:
sudo systemctl stop gateway-green.service
```

---

## Credentials and Config Storage

| What | Where | Mode | In git? |
|------|-------|------|---------|
| HA URL, token, gateway secret | `/etc/home-automation/gateway-blue.env` | `640 root:home-automation` | ❌ Never |
| HA URL, token, gateway secret | `/etc/home-automation/gateway-green.env` | `640 root:home-automation` | ❌ Never |
| Secret templates (no real values) | `ops/systemd/gateway-*.env.example` | standard | ✅ Committed |
| nginx config (no secrets) | `ops/nginx/gateway-site.conf` | standard | ✅ Committed |
| systemd units (no secrets) | `ops/systemd/gateway-*.service` | standard | ✅ Committed |
| Active color state | `/var/lib/home-automation/active_color` | standard | ❌ Runtime only |

Rules enforced by `.gitignore`:

```
secrets/
.env
.env.*
!.env.example
*.secret
```

The env files under `/etc/home-automation/` are outside the repository and
are never accidentally added to git.

---

## Recovering from Partial Failure

### nginx reload failed but health check passed

The new instance is running but traffic was not switched.  Fix nginx
manually then reload:

```bash
sudo nginx -t
sudo nginx -s reload
# If nginx -t fails, investigate /var/log/nginx/error.log
```

### Health check timed out, old instance still active

The deployment script aborted safely.  Investigate the new instance:

```bash
systemctl status gateway-green.service
journalctl -u gateway-green.service -n 50
curl -s http://127.0.0.1:8082/health
```

Common causes:
- Missing or incorrect `/etc/home-automation/gateway-green.env`.
- Home Assistant is not reachable (check `HA_URL`).
- Port conflict (another process on 8082).

After fixing, re-run the deploy:

```bash
bash deploy/deploy.sh
```

### State file is missing or corrupt

Determine which instance is actually live by checking nginx:

```bash
cat /etc/nginx/conf.d/gateway-active-upstream.conf
# Look for the port: 8081 = blue, 8082 = green
echo "blue" | sudo tee /var/lib/home-automation/active_color  # adjust accordingly
```

### Both instances are stopped

Start the known-good instance manually:

```bash
sudo systemctl start gateway-blue.service
curl http://127.0.0.1:8081/health
# If healthy, ensure nginx points to it:
sudo cp ops/nginx/gateway-blue-upstream.conf \
    /etc/nginx/conf.d/gateway-active-upstream.conf
sudo nginx -s reload
echo "blue" | sudo tee /var/lib/home-automation/active_color
```

---

## Operational Reference

### Useful commands

```bash
# Deploy
bash deploy/deploy.sh

# Deploy, keep old running
bash deploy/deploy.sh --no-stop-old

# Rollback
bash deploy/rollback.sh

# Check active color
cat /var/lib/home-automation/active_color

# Direct health checks
curl http://127.0.0.1:8081/health   # blue
curl http://127.0.0.1:8082/health   # green

# Service logs
journalctl -u gateway-blue.service -f
journalctl -u gateway-green.service -f

# nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Reload nginx after manual config change
sudo nginx -t && sudo nginx -s reload
```

### Port reference

| Instance | Port |
|----------|------|
| gateway-blue  | 8081 |
| gateway-green | 8082 |
| nginx (public) | 80 |

### Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_PORT` | Yes | `8081` | TCP port for this instance |
| `GATEWAY_COLOR` | Yes | `blue` | Deployment slot name |
| `HA_URL` | Yes | – | Home Assistant base URL |
| `HA_TOKEN` | Yes | – | Home Assistant long-lived access token |
| `GATEWAY_SECRET` | No | `""` | Shared secret for `X-Gateway-Secret` header |
