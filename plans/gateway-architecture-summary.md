# Architecture Summary — Home Gateway + Cloudflare + Local Services

## Overview

This system is a hybrid edge + home-lab architecture designed to securely expose selected services from a private home network to the public internet, while maintaining strong control over routing, deployment, and internal service orchestration.

---

## High-Level Flow

```
Public Internet
      ↓
Cloudflare (DNS + Access + DDoS protection)
      ↓
Secure Tunnel / VPN (Cloudflare Tunnel or WireGuard)
      ↓
Gateway Server (home network entry point)
      ↓
Reverse Proxy + Blue/Green App Services
      ↓
Internal Network Services (LM Studio, Redis, storage, DB)
```

---

## Components

### 1. Cloudflare (Public Edge)
- Acts as the public entry point
- Provides:
  - DNS
  - TLS termination
  - DDoS protection
  - Authentication via Cloudflare Access
- Only allows traffic from Cloudflare to reach the gateway

---

### 2. Secure Tunnel / VPN
- Connects Cloudflare edge to the home network
- Options:
  - Cloudflare Tunnel (preferred for simplicity)
  - WireGuard (for full network access)
- Ensures the gateway is not directly exposed to the internet

---

### 3. Gateway Server (Home Network)
- Runs on a dedicated machine (Debian, headless)
- Responsibilities:
  - Reverse proxy (Nginx or Traefik)
  - Routing incoming requests to services
  - Hosting deployable applications
  - Running CI/CD deployment targets (self-hosted GitHub runner)
  - Managing blue/green deployments

---

### 4. Blue/Green Application Layer
- Two parallel runtime environments:
  - `blue` (active or standby)
  - `green` (active or standby)
- Deployment process:
  1. Deploy to inactive slot
  2. Run health checks
  3. Switch traffic via reverse proxy
  4. Keep previous version for rollback

- Stable path:

```
/srv/apps/<app>/current
```

Used by:
- scheduled jobs
- scripts
- internal references

---

### 5. Internal Service Layer (LAN)

Other machines on the home network provide supporting services:

- **LM Studio nodes**
  - Local LLM inference endpoints
  - Multiple machines with different models/personalities

- **Redis**
  - Caching
  - Pub/sub for multi-agent workflows
  - Queueing jobs

- **Storage**
  - Shared filesystem or NAS
  - Model files, assets, logs

- **Database (optional)**
  - Postgres / SQLite depending on use case

These services are:
- NOT publicly exposed
- Only accessible from the gateway or VPN clients

---

## Deployment Model

- Source: GitHub
- Trigger: merge to `main`
- CI/CD:
  - GitHub Actions
  - Self-hosted runner on gateway
- Deployment:
  - Pull commit
  - Build app
  - Deploy to inactive slot
  - Health check
  - Switch traffic
  - Install/update scheduled jobs (systemd timers)

---

## Scheduled Jobs

- Defined in source control (no manual crontab edits)
- Deployed alongside application code
- Implemented as:
  - systemd timers (preferred)
  - or `/etc/cron.d` managed files
- Jobs execute against:

```
/srv/apps/<app>/current
```

Ensuring they follow the active deployment and rollback automatically

---

## Security Model

- No direct public exposure of home network
- All ingress routed through Cloudflare
- Gateway only accepts trusted tunnel traffic
- Internal services isolated to LAN
- Sensitive infrastructure paths protected in source control

---

## Design Goals

- Fully reproducible deployments
- No manual server drift (everything defined in Git)
- Safe, fast rollback via blue/green
- Ability to run local AI infrastructure (LM Studio) behind a secure gateway
- Extensible to additional internal services and agents

---

## Mental Model

Think of the gateway as:

> A private cloud edge node running inside your house, fronted by Cloudflare, orchestrating local compute resources like a mini data center.
