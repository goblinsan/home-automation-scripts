# Copilot Instructions For gateway-control-plane

## Start here

Read these docs before making changes to this repo:

- `docs/intent.md` — Why this system exists and its design principles
- `docs/service-contract.md` — What apps must provide to be deployable
- `docs/monitoring.md` — Health monitoring system and contract
- `docs/architecture.md` — Component responsibilities and routing model
- `docs/deployment.md` — Blue/green deploy and rollback mechanics
- `docs/remote-workloads.md` — Worker nodes and remote Docker workloads

For private operational details (IPs, credentials, topology), check `docs/local/`
if you have access. Those files are gitignored and contain the real infrastructure
state.

> Public docs describe stable architecture and contracts.
> `docs/local/` contains live operational detail and may drift; treat it as
> situational context, not schema.

## What this repo is

This is the infrastructure control plane for a private gateway. It manages
blue/green containerized deployments, nginx routing, service configuration,
remote worker nodes, health monitoring, and an admin UI — all driven by a
single JSON config file.

It does NOT contain application code. The apps it manages live in separate repos
(`gateway-api`, `gateway-chat-platform`) and conform to the service contract
defined in `docs/service-contract.md`.

## Key files

| Path | Purpose |
|------|---------|
| `configs/gateway.config.example.json` | Full config schema with placeholder values |
| `src/lib/admin-ui.ts` | Admin server + inline SPA (~9000+ lines) |
| `src/lib/deploy.ts` | Blue/green deploy, rollback, smoke test |
| `src/lib/nginx.ts` | Nginx config and upstream generation |
| `src/lib/metrics.ts` | Health monitoring, Postgres/Redis, benchmarks |
| `src/lib/remote-worker.ts` | Gateway-worker rendering and deploy |
| `src/lib/remote-workloads.ts` | Remote workload rendering and deploy |
| `src/cli.ts` | CLI entry point for all commands |
| `deploy/bin/*.sh` | Deploy wrapper scripts called by GitHub Actions |
| `migration/metrics/*.sql` | Monitoring database migrations |

## Admin UI

`admin-ui.ts` is a single large file containing:
- An HTTP API server with all management endpoints
- An inline single-page admin application (HTML/CSS/JS)
- Three main tabs: Services, Infrastructure, Monitoring
- Config editing, deploy operations, live proxying to managed apps

When editing the admin UI, be aware that it's a monolithic inline app. The
client-side JavaScript is embedded as template literals in the server code.

## Config-driven architecture

Everything flows from `gateway.config.json`:

1. The **admin UI** reads and writes it
2. The **CLI build command** renders all artifacts from it (nginx, systemd,
   env files, worker bundles)
3. The **deploy system** reads app definitions, slots, and build commands from it
4. The **health monitor** reads probe targets from it
5. The **worker system** reads node and workload definitions from it

If you add a new operational capability, it should be driven by config, not by
hardcoded values in source.

## Changes that affect other repos

This repo's deploy system manages apps from `gateway-api` and
`gateway-chat-platform`. If you change any of the following, you must
coordinate with those repos:

- Management API endpoint paths or shapes that the admin UI proxies
- Service profile env file format
- Agent sync payload schema
- Deploy token names or semantics
- Health check behavior

Read each app's `.github/copilot-instructions.md` for their side of the
contract.

## CLI

All operations go through `node src/cli.ts <command>`:

```
validate, lint, typecheck, build, serve-ui,
deploy-app, rollback-app, smoke-test,
install-jobs, install-control-plane-service,
apply-service-profiles, run-agent,
import-workflow-seed, deploy-remote-workload,
control-minecraft, render-nginx-site, render-upstream
```

Node 24+ required (uses native TypeScript execution via `--experimental-strip-types`).

## Do not commit

- Real config files with secrets (`configs/gateway.config.json`)
- Anything in `docs/local/` (gitignored)
- IP addresses, hostnames, or credentials
- SSH keys or tokens
