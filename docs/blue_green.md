# Blue-Green Deployment for the Gateway Service

This document describes how the gateway is deployed with host-level `nginx`
and `systemd`, while the app itself runs as Docker containers in blue/green
slots.

---

## Overview

```text
                         +---------------------------------------+
 External / LAN traffic  | nginx                                 |
 ----------------------> | port 80                               |
                         | includes active upstream config       |
                         +-------------------+-------------------+
                                             |
                                             v
                                 +-----------+-----------+
                                 | gateway_active        |
                                 | 127.0.0.1:<slot-port> |
                                 +-----------+-----------+
                                             |
                    +------------------------+------------------------+
                    |                                                 |
                    v                                                 v
         +----------+----------+                           +----------+----------+
         | gateway-blue.service|                           | gateway-green.service|
         | docker run image    |                           | docker run image     |
         | home-automation-    |                           | home-automation-     |
         | gateway:blue        |                           | gateway:green        |
         | port 8081           |                           | port 8082            |
         +----------+----------+                           +----------+----------+
                    |                                                 |
                    +------------------------+------------------------+
                                             |
                                             v
                                Home Assistant / local APIs
```

The host owns ingress and service supervision. Each slot runs its own Docker
image tag, so blue and green can hold different releases at the same time.

---

## Components

| Component | Role |
|----------|------|
| `gateway/app.py` | Flask gateway app and `/health` endpoint |
| `gateway/Dockerfile` | Immutable runtime image for the gateway app |
| `ops/systemd/gateway-blue.service` | Runs the blue slot container |
| `ops/systemd/gateway-green.service` | Runs the green slot container |
| `ops/systemd/gateway-*.env.example` | Per-slot env templates, including slot image tags |
| `ops/systemd/timers/` | Source-controlled host timer units for recurring automation |
| `ops/systemd/automation.env.example` | Optional env file for timer task secrets and overrides |
| `deploy/deploy.sh` | Build inactive slot image, restart slot, switch nginx |
| `deploy/rollback.sh` | Switch nginx back to the other slot |
| `deploy/smoke_test.sh` | Health smoke tests before and after cutover |
| `deploy/install_scheduled_jobs.sh` | Install and enable managed systemd timers |
| `/etc/nginx/conf.d/gateway-active-upstream.conf` | Active upstream pointer managed by deploy scripts |
| `/var/lib/home-automation/active_color` | Runtime state file tracking the live slot |

---

## Why Docker Here

The repo previously restarted two services from the same checkout. That gave
two ports, but not two isolated releases. Containerizing only the app layer
fixes that without moving ingress or service supervision into Docker.

Benefits:

- Blue and green hold different immutable releases.
- Rollback is a traffic switch, not a `git` operation.
- Host `nginx` and `systemd` stay simple and explicit.
- The gateway can still use normal host timers and operational tooling.

---

## Runtime Files

Files outside the repo:

```text
/etc/home-automation/
  gateway-blue.env
  gateway-green.env

/etc/nginx/conf.d/
  gateway-active-upstream.conf

/var/lib/home-automation/
  active_color
```

The env files contain both runtime config and the slot image tag:

```dotenv
GATEWAY_PORT=8081
GATEWAY_COLOR=blue
GATEWAY_IMAGE=home-automation-gateway:blue
HA_URL=http://homeassistant.local:8123
HA_TOKEN=replace_me
GATEWAY_SECRET=
```

Optional host-side automation env file:

```text
/etc/home-automation/automation.env
```

This is used by the managed `systemd` timers for task-specific values such as
Strava credentials or health-check thresholds.

---

## Initial Setup

### 1. Install host dependencies

- Docker Engine
- nginx
- systemd
- curl
- git

### 2. Clone the repo

```bash
sudo git clone https://github.com/goblinsan/home-automation-scripts.git \
    /opt/home-automation-scripts
sudo chown -R home-automation:home-automation /opt/home-automation-scripts
```

### 3. Create the slot env files

```bash
sudo mkdir -p /etc/home-automation
sudo cp /opt/home-automation-scripts/ops/systemd/gateway-blue.env.example \
    /etc/home-automation/gateway-blue.env
sudo cp /opt/home-automation-scripts/ops/systemd/gateway-green.env.example \
    /etc/home-automation/gateway-green.env
```

Fill in the real `HA_URL`, `HA_TOKEN`, and optional `GATEWAY_SECRET`.

### 4. Install the systemd units

```bash
sudo cp /opt/home-automation-scripts/ops/systemd/gateway-blue.service /etc/systemd/system/
sudo cp /opt/home-automation-scripts/ops/systemd/gateway-green.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gateway-blue.service gateway-green.service
```

### 5. Configure timer task environment

```bash
sudo cp /opt/home-automation-scripts/ops/systemd/automation.env.example \
    /etc/home-automation/automation.env
```

### 6. Configure nginx

```bash
sudo cp /opt/home-automation-scripts/ops/nginx/gateway-site.conf /etc/nginx/sites-available/gateway
sudo ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/gateway
sudo cp /opt/home-automation-scripts/ops/nginx/gateway-blue-upstream.conf \
    /etc/nginx/conf.d/gateway-active-upstream.conf
sudo nginx -t && sudo nginx -s reload
```

### 7. Build and start the initial slot

```bash
cd /opt/home-automation-scripts
docker build -t home-automation-gateway:blue -f gateway/Dockerfile .
sudo systemctl start gateway-blue.service
echo "blue" | sudo tee /var/lib/home-automation/active_color
```

### 8. Install the managed timers

```bash
cd /opt/home-automation-scripts
bash deploy/install_scheduled_jobs.sh
```

---

## Deploying

Standard deployment:

```bash
cd /opt/home-automation-scripts
bash deploy/deploy.sh
```

Keep the old slot running for fast rollback:

```bash
bash deploy/deploy.sh --no-stop-old
```

Dry-run:

```bash
bash deploy/deploy.sh --dry-run
```

The deploy script:

1. Optionally pulls the latest repo state.
2. Determines the inactive slot.
3. Builds `home-automation-gateway:<slot>`.
4. Restarts `gateway-<slot>.service`.
5. Waits for `http://127.0.0.1:<slot-port>/health`.
6. Switches nginx.
7. Verifies `/health` through nginx.
8. Installs or refreshes managed `systemd` timers from source control.
9. Updates the state file.
10. Optionally stops the previous slot.

---

## Rolling Back

```bash
cd /opt/home-automation-scripts
bash deploy/rollback.sh
```

Rollback works because the other slot keeps its previous image tag and
container state until it is reused for a later deployment.

---

## Smoke Tests

Direct slot:

```bash
bash deploy/smoke_test.sh --url http://127.0.0.1:8081/health --expect-color blue
```

Through nginx:

```bash
bash deploy/smoke_test.sh --url http://127.0.0.1/health --expect-color blue
```

---

## Operational Notes

- `gateway-blue.service` and `gateway-green.service` run as `home-automation`
  and require access to the Docker socket.
- Container logs go to `journald` via `systemd`, not the repo `logs/`
  directory.
- `nginx` remains on the host because it is the stable ingress layer.
- Recurring automation on the gateway should use the units in
  `ops/systemd/timers/`, not per-user crontab edits.
- This repo still contains Python automation scripts; only the gateway app
  layer has been containerized.
