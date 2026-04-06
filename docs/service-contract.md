# Service Contract

This document defines what an application must provide to be deployed, monitored,
configured, and controlled by the gateway control plane.

If you are building or modifying a service that will be managed by this system,
your repo must satisfy these requirements.

## 1. Container Contract

### Required: Docker Compose

Every app must have a `docker-compose.yml` at its repo root that:

- Accepts `HOST_PORT` as an environment variable for the externally bound port
- Supports `docker compose up -d --build --remove-orphans` as the start command
- Supports `docker compose down --remove-orphans` as the stop command
- Uses a project name that includes the slot identifier (provided by the deploy
  system via tokenized commands)

### Required: Health Endpoint

Every app must expose an HTTP GET endpoint that returns a 2xx status when the
service is ready to accept traffic. This endpoint is used for:

- Post-deploy smoke tests (retried up to 10 times with 2-second intervals)
- Ongoing health monitoring probes
- Blue/green promotion decisions — traffic only switches after health passes

The endpoint path is configured per-app in `gateway.config.json` (e.g.,
`/health`, `/healthz`, `/api/agents`). It must respond within 5 seconds.

### Required: PORT Binding

The container must listen on the port specified by `HOST_PORT`. The deploy system
resolves this from the slot configuration — blue and green slots use different
ports so both can run simultaneously during transitions.

### Recommended: Stateless Containers

Containers should not store persistent state inside the container filesystem.
Use mounted volumes or external services (Postgres, Redis) for durable data.
The deploy system destroys and recreates the slot container on each deploy.

## 2. Repo Layout Contract

The deploy system clones your repo into `/srv/apps/<app-id>/<slot>/` on the
gateway host. It expects:

```
<repo-root>/
  docker-compose.yml    ← required
  Dockerfile            ← required (referenced by docker-compose.yml)
  package.json          ← if Node.js, for build commands
```

### Build Commands

The control plane runs configured build commands in the repo checkout directory
before starting the container. Common examples:

- `npm ci`
- `npm run build`
- `corepack enable && pnpm install`

These are defined in `gateway.config.json` per app, not hardcoded in the deploy
system.

## 3. Environment File Contract

The control plane generates environment files from service profiles and places
them in the app's `shared/` directory at deploy time:

```
/srv/apps/<app-id>/shared/<env-file-name>
```

Your `docker-compose.yml` should reference the env file using a path that the
deploy system resolves via token substitution. The deploy command replaces tokens
like `__SHARED__` with the actual shared directory path.

### What Goes in Env Files

The control plane manages:

- Runtime configuration (ports, base URLs, feature flags)
- API keys and secrets
- Service-specific settings (TTS endpoints, model defaults, database URLs)

Your app should read its configuration from environment variables populated by
this file. Do not hardcode secrets or connection strings in your repo.

## 4. API Contract for Managed Services

If your app exposes management APIs that the control plane interacts with, those
endpoints are part of the deployment contract. Changing them requires a
coordinated update to `gateway-control-plane`.

### gateway-api Endpoints

The control plane proxies workflow management through these endpoints:

| Method | Path | Purpose |
|--------|------|---------|
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

### gateway-chat-platform Endpoints

The control plane manages agents and providers through these endpoints:

| Method | Path | Purpose |
|--------|------|---------|
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
- Docker Compose service names or startup contract
- Environment variable names your app requires
- Management API endpoint paths, request shapes, or response shapes
- Port expectations
- Readiness semantics (what "healthy" means)

Each app's `.github/copilot-instructions.md` contains its own list of
coordination requirements. Read those before making cross-repo changes.

## 9. Adding a New App

To add a new app to the control plane:

1. Create the app repo with a `Dockerfile` and `docker-compose.yml` that
   accepts `HOST_PORT`
2. Add a health endpoint
3. Add an entry to `gateway.config.json` under `apps[]` with:
   - unique `id`
   - `repoUrl` pointing to your GitHub repo
   - `healthPath` for your health endpoint
   - `slots.blue` and `slots.green` with distinct ports and tokenized
     start/stop commands
   - `routePath` and/or `hostnames[]` for nginx routing
4. Optionally add a service profile if the control plane should manage env
   files or runtime config for the app
5. Add a `deploy-on-merge.yml` GitHub Actions workflow that calls the
   control plane's deploy script on the self-hosted gateway runner
6. Run `build` to regenerate nginx and upstream configs
7. Deploy with `deploy-app.sh`
