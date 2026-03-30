# Gateway Control Plane

This repo is the gateway-server control plane.

It exists to define and maintain:

- reverse-proxy routing on the gateway host
- blue/green deployment mechanics for apps deployed on the gateway
- source-controlled scheduled jobs
- remote worker-node workload orchestration for container jobs and Bedrock servers
- service-specific runtime config, env files, and secrets
- chat-agent definitions for the local chat platform
- deployment and rollback tooling
- CI/CD scaffolding for automated promotion to the gateway

It is not an application proxy for Home Assistant or any other single product.

## Target Model

The repo is aligned to the plans in `plans/`:

- Cloudflare at the public edge
- tunnel or VPN into the home network
- gateway server as the ingress and deployment target
- generic blue/green app slots under `/srv/apps/<app>/`
- scheduled jobs executed from `/srv/apps/<app>/current`

The current first-class managed apps are:

- `gateway-control-plane`
- `gateway-api`
- `gateway-chat-platform`

OpenClaw migration assets live in:

- `migration/openclaw/`

The intended stable checkout path on the gateway host is:

- `/opt/gateway-control-plane`

## Repo Layout

```text
.
├── configs/
│   └── gateway.config.example.json
├── Dockerfile
├── docker-compose.yml
├── deploy/
│   └── bin/
│       ├── deploy-app.sh
│       ├── rollback-app.sh
│       ├── install-scheduled-jobs.sh
│       └── smoke-test-app.sh
├── docs/
│   ├── architecture.md
│   ├── bootstrap.md
│   ├── deployment.md
│   ├── ci-cd.md
│   └── remote-workloads.md
├── infra/
│   ├── nginx/
│   └── systemd/
├── src/
│   ├── cli.ts
│   └── lib/
└── tests/
```

## Tooling

This repo is TypeScript-first and runs on Node 24+ using native type stripping.
That keeps the clean-slate bootstrap small while still letting the repo use TS
immediately.

Available commands:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run validate
npm run ui
deploy/bin/install-control-plane-service.sh --config configs/gateway.config.json
deploy/bin/apply-service-profiles.sh --config configs/gateway.config.json --app gateway-chat-platform
deploy/bin/import-workflow-seed.sh --base-url http://127.0.0.1:3000
node src/cli.ts run-agent --config configs/gateway.config.json --app gateway-chat-platform --agent bruvie-d --prompt "Give me a quick readiness check."
node src/cli.ts deploy-remote-workload --config configs/gateway.config.json --workload kulrs-palette
node src/cli.ts control-minecraft --config configs/gateway.config.json --workload bedrock-main --action broadcast --message "Restart in 5 minutes"
```

## What The Build Produces

`npm run build` renders example gateway artifacts into `generated/`:

- `generated/nginx/gateway-site.conf`
- `generated/nginx/upstreams/<app>-blue.conf`
- `generated/nginx/upstreams/<app>-green.conf`
- `generated/systemd/jobs/*.service`
- `generated/systemd/jobs/*.timer`
- `generated/services/gateway-api/gateway-api.env`
- `generated/services/gateway-api/job-channels.json`
- `generated/services/gateway-api/kulrs-activity.env`
- `generated/services/gateway-api/kulrs.json`
- `generated/services/gateway-chat-platform/chat-api.env`
- `generated/services/gateway-chat-platform/agents.json`
- `generated/nodes/<node>/worker/worker-config.json`
- `generated/nodes/<node>/worker/gateway-worker.mjs`
- `generated/nodes/<node>/worker/Dockerfile`
- `generated/nodes/<node>/worker/compose.yml`
- `generated/nodes/<node>/workloads/<workload>/compose.yml`
- `generated/nodes/<node>/workloads/<workload>/scripts/*`
- `generated/nodes/<node>/workloads/<workload>/runtime/*`

These are generated from `configs/gateway.config.example.json`.

The control plane itself is also containerized in this repo:

- [`Dockerfile`](/Users/jamescoghlan/code/home-automation-scripts/Dockerfile)
- [`docker-compose.yml`](/Users/jamescoghlan/code/home-automation-scripts/docker-compose.yml)

That lets `gateway-control-plane` participate in the same blue/green
deployment flow as the other managed apps.

## Admin UI

This repo also includes a built-in admin UI for editing the gateway config file.
It exposes the same config shape used by the CLI, including:

- gateway settings
- admin UI runtime and route settings
- apps and blue/green slot commands
- scheduled job timings
- feature enable/disable flags
- `gateway-api` env and secret values
- `gateway-api` named delivery channels for job runtime
- `gateway-api` KULRS credentials, schedule, and enable/disable state
- `gateway-api` workflow management through the live workflow API
- worker node definitions for remote Docker hosts
- remote workload definitions for scheduled container jobs and Minecraft Bedrock servers
- remote deploy actions for worker-node workloads
- a containerized remote `gateway-worker`, so worker nodes only need Docker plus SSH access
- Minecraft Bedrock control actions: start, stop, restart, broadcast, kick, ban, and update-if-empty
- `gateway-chat-platform` env, provider keys, and agent definitions
- `gateway-chat-platform` local TTS service configuration
- local TTS voice browsing, transcript-aware voice creation, and agent-to-voice mapping
- live workflow-seed import into `gateway-api`
- live agent sync and agent-run execution against `gateway-chat-platform`

For ad hoc use:

```bash
npm run ui
```

Then open `http://127.0.0.1:4173`.

For the intended gateway-host model, treat the control plane as a normal
blue/green app. The cleanest setup is dedicated hostnames per app, for example:

- `admin.gateway.example.test`
- `api.gateway.example.test`
- `chat.gateway.example.test`

The example config keeps the older path routes as a fallback (`/admin/`,
`/api/`, `/chat/`), but separate hostnames avoid cookie collisions between the
admin UI and chat UI. Keep `gateway.adminUi.enabled` disabled unless you
explicitly want the legacy singleton systemd service for development or rescue
access.

Each managed repo should deploy itself by invoking the control plane on the
gateway host. The intended GitHub Actions command shape is:

```bash
/opt/gateway-control-plane/deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app <app-id> --revision "${GITHUB_SHA}"
```

The three app ids are:

- `gateway-control-plane`
- `gateway-api`
- `gateway-chat-platform`

## Next Host Setup

If you already tried the previous Python/HA-oriented setup on the server, do not
continue with it. Use the cleanup notes in [docs/bootstrap.md](docs/bootstrap.md)
before provisioning the clean-slate gateway host layout.
