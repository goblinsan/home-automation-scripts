# Blue/Green App Contract

This document defines what an application must provide to be deployed, monitored,
configured, and controlled by the gateway control plane as a blue/green app.

The control plane also manages scheduled jobs, remote workloads, and service
profiles, which have different requirements. This document covers only the
blue/green app deployment model.

## 1. What The Control Plane Actually Requires

For a blue/green managed app, the deploy engine requires a config entry that
provides:

- `repoUrl` — where to clone the app source
- `deployRoot` — the host directory for slot checkouts
- `healthPath` — the endpoint to smoke-test after startup
- `buildCommands` — commands to run in the checkout before starting
- `slots.blue.startCommand` / `slots.blue.stopCommand`
- `slots.green.startCommand` / `slots.green.stopCommand`

The deploy engine is **command-driven**. It does not inherently require Docker
Compose, `HOST_PORT`, or a specific repo layout. It runs whatever start/stop
commands the config defines for each slot. Those commands are tokenized with
slot-specific values (see section 7).

### Required: Health Endpoint

Every app must expose an HTTP GET endpoint that returns a 2xx status when the
service is ready to accept traffic. This endpoint is used for:

- Post-deploy smoke tests (retried up to 10 times with 2-second intervals)
- Ongoing health monitoring probes
- Blue/green promotion decisions — traffic only switches after health passes

The endpoint path is configured per-app in `gateway.config.json` (e.g.,
`/health`, `/healthz`, `/api/agents`). It must respond within 5 seconds.

### Recommended: Stateless Containers

Containers should not store persistent state inside the container filesystem.
Use mounted volumes or external services (Postgres, Redis) for durable data.
The deploy system destroys and recreates the slot on each deploy.

## 2. Current House Style For Gateway Apps

The existing gateway apps all follow this convention:

- A repo-root `docker-compose.yml` and `Dockerfile`
- Slot commands that pass `HOST_PORT=__SLOT_PORT__` to Docker Compose
- Env files referenced from `__SHARED__`
- Docker Compose project names that include `__SLOT__` for blue/green isolation

Follow this pattern for consistency unless you have a reason not to. The deploy
engine does not enforce it — it simply runs the configured commands.

### Build Commands

The control plane runs configured build commands in the repo checkout directory
before starting the slot. Common examples:

- `npm ci`
- `npm run build`
- `corepack enable && pnpm install`

These are defined in `gateway.config.json` per app, not hardcoded in the deploy
system.

## 3. Environment File Contract

The control plane can generate environment files from service profiles and place
them in the app's `shared/` directory at deploy time:

```
/srv/apps/<app-id>/shared/<env-file-name>
```

This is a service-profile convention, not a deploy-engine requirement. If your
app has a service profile in the control plane config, the deploy system will
write the generated env file to the shared directory using token substitution
(e.g., `__SHARED__` resolves to the shared path).

### What Goes in Env Files

Service profiles manage:

- Runtime configuration (ports, base URLs, feature flags)
- API keys and secrets
- Service-specific settings (TTS endpoints, model defaults, database URLs)

Your app should read its configuration from environment variables populated by
this file. Do not hardcode secrets or connection strings in your repo.

## 4. API Contract for Managed Services

If your app exposes management APIs that the control plane interacts with, those
endpoints are part of the deployment contract. Changing them requires a
coordinated update to `gateway-control-plane`.

The paths listed below are **upstream app paths** — the paths your app must
serve. The control plane's admin UI proxies these through its own namespaced
routes (e.g., `/api/chat-platform/providers/status` proxies to the upstream
app's `/api/providers/status`).

### gateway-api Upstream Endpoints

| Method | Upstream Path | Purpose |
|--------|---------------|---------|
| GET | `/api/workflows` | List all workflows |
| GET | `/api/workflows/:id` | Get workflow by ID |
| POST | `/api/workflows` | Create workflow |
| PUT | `/api/workflows/:id` | Update workflow |
| DELETE | `/api/workflows/:id` | Delete workflow |
| POST | `/api/workflows/:id/enable` | Enable workflow |
| POST | `/api/workflows/:id/disable` | Disable workflow |
| POST | `/api/workflows/:id/sleep` | Sleep workflow |
| POST | `/api/workflows/:id/resume` | Resume workflow |
| POST | `/api/workflows/:id/run` | Trigger workflow run |
| POST | `/internal/workflows/:id/execute` | Internal execution hook |

### gateway-chat-platform Upstream Endpoints

| Method | Upstream Path | Purpose |
|--------|---------------|---------|
| GET | `/api/providers/status` | Provider availability |
| GET | `/api/providers/:name/models` | List models for provider |
| GET | `/api/agents` | List agents (also used as readiness) |
| POST | `/api/agents/:id/run` | Execute agent |
| GET | `/api/agents/manage` | List managed agents |
| GET | `/api/agents/manage/:id` | Get managed agent |
| POST | `/api/agents/manage` | Create agent |
| PUT | `/api/agents/manage/:id` | Update agent |
| DELETE | `/api/agents/manage/:id` | Delete agent |
| POST | `/api/agents/manage/sync` | Bulk sync all configured agents |

### Sync Behavior

During deploy, the control plane calls `POST /api/agents/manage/sync` with the
full set of configured agents. This reconciles the running service's agent list
with the control plane's desired state. The sync is authoritative — agents not
in the control plane config may be removed.

## 5. Nginx Routing Contract

The control plane generates nginx configuration that routes traffic to your app.
Each app has:

- A **route path** (e.g., `/api/`, `/chat/`, `/admin/`) on the shared gateway
  hostname
- Optional **dedicated hostnames** (e.g., `api.example.test`) for cleaner
  browser access
- An **upstream config file** that the deploy system rewrites on promotion

The app does not need to know about nginx. The control plane handles:

- Writing `upstream <app-id>_active { server 127.0.0.1:<port>; }` to the
  upstream conf path
- Reloading nginx after upstream changes
- Configuring `proxy_pass` with optional path stripping

### Path Stripping

If `stripRoutePrefix` is enabled for your app, requests to `/api/foo` arrive at
your container as `/foo`. If disabled, they arrive as `/api/foo`. Your app must
handle whichever mode is configured.

## 6. Scheduled Job Contract

If your app has background jobs managed by the control plane, they are defined
in `gateway.config.json` as `scheduledJobs` entries referencing your app ID.

Jobs are rendered as systemd service and timer units on the gateway host. They
reference `/srv/apps/<app-id>/current/` (a symlink to the active slot), so job
code automatically tracks the live deployment.

Your job scripts must:

- Be executable from the working directory specified in config
- Exit with code 0 on success, non-zero on failure
- Not assume a specific slot color — always use the `current` symlink path

## 7. Slot Token Reference

The deploy system resolves these tokens in start/stop commands and paths:

| Token | Resolves To |
|-------|-------------|
| `__APP_ID__` | The app identifier |
| `__SLOT__` | `blue` or `green` |
| `__SLOT_DIR__` | Full path to the slot checkout |
| `__SLOT_PORT__` | The port for this slot |
| `__DEPLOY_ROOT__` | `/srv/apps/<app-id>` |
| `__CURRENT__` | `/srv/apps/<app-id>/current` |
| `__SHARED__` | `/srv/apps/<app-id>/shared` |
| `__HEALTH_PATH__` | The configured health endpoint path |

## 8. What Requires Coordination

If you change any of the following in your app repo, the control plane config or
code must be updated in the same change set:

- Health endpoint path or behavior
- Container startup contract (Dockerfile, compose, service names)
- Environment variable names your app requires
- Management API endpoint paths, request shapes, or response shapes
- Port expectations
- Readiness semantics (what "healthy" means)

Where present, repo-level `.github/copilot-instructions.md` files should be
treated as part of the coordination contract. Read those before making
cross-repo changes.

## 9. Adding a New App

To add a new app to the control plane:

1. Create the app repo with a health endpoint and a way to start/stop the
   service (the current house style uses Docker Compose with `HOST_PORT`)
2. Add an entry to `gateway.config.json` under `apps[]` with:
   - unique `id`
   - `repoUrl` pointing to your repo
   - `healthPath` for your health endpoint
   - `buildCommands` for any pre-start build steps
   - `slots.blue` and `slots.green` with distinct ports and tokenized
     start/stop commands
   - `routePath` and/or `hostnames[]` for nginx routing
3. Optionally add a service profile if the control plane should manage env
   files or runtime config for the app
4. Add a deploy workflow (e.g., `deploy-on-merge.yml`) that calls the
   control plane's deploy script on the self-hosted gateway runner
5. Run `build` to regenerate nginx and upstream configs
6. Deploy with `deploy-app.sh`
