# Gateway Control Plane — Intent & Overview

This document explains the purpose of this system for agents and contributors
working across the gateway ecosystem. It covers the "why" and the high-level
design principles. For contract details, see [service-contract.md](service-contract.md).
For deployment mechanics, see [deployment.md](deployment.md).

## What This System Is

The gateway control plane is a single-repo infrastructure manager for a small
private network of services. It treats the gateway host as **infrastructure**,
not as a single application.

It manages:

- blue/green containerized deployments of multiple applications
- nginx reverse-proxy configuration and traffic switching
- service configuration (env files, agent definitions, job channels)
- remote worker nodes and their Docker workloads over SSH
- health monitoring with Postgres-backed time-series data
- a built-in admin UI for operating everything from one place

## What This System Is Not

- It is not a cloud orchestrator like Kubernetes. It manages a small number of
  known hosts on a private LAN.
- It is not a CI/CD platform. GitHub Actions triggers deployments; this repo
  provides the deploy scripts they call.
- It does not own the application code. Each app lives in its own repo and must
  conform to a deployment contract (see [service-contract.md](service-contract.md)).

## Core Principles

### 1. Config-Driven Everything

A single JSON config file (`gateway.config.json`) is the source of truth for the
entire system. It defines apps, slots, ports, routes, worker nodes, workloads,
scheduled jobs, feature flags, service profiles, and monitoring settings.

The CLI and admin UI both read and write this same file. The `build` command
renders all deployment artifacts (nginx configs, systemd units, env files, worker
bundles) from this config. Nothing is manually wired.

### 2. Blue/Green Zero-Downtime Deploys

Every app is deployed into one of two slots (blue or green). The deploy process:

1. Targets the **inactive** slot
2. Builds and starts the new version on the slot's dedicated port
3. Health-checks the new version directly
4. Switches the nginx upstream to point at the new slot only after health passes
5. Records the new active slot

The old slot stays running until the next deploy overwrites it. Rollback is
instant — it just flips the upstream pointer back without rebuilding.

This means there is always a known-good version ready to receive traffic while
the new version is being validated.

### 3. Apps Are Independent Repos

The control plane does not contain application code. Each app lives in its own
GitHub repo and is responsible for:

- its own Dockerfile and docker-compose.yml
- its own CI workflows
- its own test suite

The control plane provides the deploy wrapper, the config, and the runtime
wiring. The apps provide the code and the container contract.

### 4. Service Profiles Bridge Config and Runtime

Some apps need more than a port and a health endpoint. The control plane defines
**service profiles** that generate app-specific configuration:

- Environment files with secrets and runtime settings
- Agent definitions for the chat platform
- Job channel mappings for the workflow API
- TTS voice and provider configuration

These profiles are rendered during build and applied during deploy, keeping
secrets out of application repos and letting the control plane be the single
point of configuration for the full stack.

### 5. Worker Nodes Extend the Compute Plane

Not all workloads run on the gateway host. The control plane manages remote
**worker nodes** over SSH, deploying Docker workloads to them:

- Scheduled container jobs (cron-like tasks)
- Long-running container services (inference APIs, databases)
- Minecraft Bedrock servers with admin controls

Each worker node gets a lightweight **gateway-worker** container that evaluates
schedules and handles control actions locally, without requiring Node.js or
cron on the worker host.

### 6. Health Monitoring Is Built In

The control plane collects health data from all managed targets:

- Worker nodes (SSH reachability)
- Apps (HTTP health endpoints)
- Remote workloads (container status)

Results are stored in Postgres with 24-hour uptime calculations and optional
Redis caching. The admin UI shows live status and history.

## Repo Map

| Repo | Role | Deployed As |
|------|------|-------------|
| `gateway-control-plane` (this repo) | Infrastructure manager, admin UI, deploy scripts | Blue/green Docker app |
| `gateway-api` | Workflow engine, job runner, GitHub integration | Blue/green Docker app |
| `gateway-chat-platform` | AI chat with agents, providers, TTS | Blue/green Docker app (multi-container) |

Related repos may include `.github/copilot-instructions.md` files documenting
coordination expectations. Read those before making changes that cross
repo boundaries.

## Documentation Map

| Document | Scope |
|----------|-------|
| [intent.md](intent.md) (this file) | Why this system exists, design principles |
| [service-contract.md](service-contract.md) | What apps must provide to be deployable |
| [monitoring.md](monitoring.md) | Health monitoring system and contract |
| [architecture.md](architecture.md) | Component responsibilities and routing model |
| [deployment.md](deployment.md) | Deploy/rollback mechanics combined with Docker slot commands |
| [ci-cd.md](ci-cd.md) | GitHub Actions setup and per-repo workflows |
| [bootstrap.md](bootstrap.md) | Fresh host setup |
| [remote-workloads.md](remote-workloads.md) | Worker nodes and remote Docker workloads |

Private operational details (IPs, credentials, hardware) live in `docs/local/`
which is gitignored.
