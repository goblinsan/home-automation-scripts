# Deployment

This repo provides generic blue/green deployment wrappers in `deploy/bin/`.

It also defines the Docker/Compose deployment model for the three gateway apps:

- `gateway-control-plane`
- `gateway-api`
- `gateway-chat-platform`

Each app is deployed into `/srv/apps/<app>/blue` or `/srv/apps/<app>/green`,
started through the slot's configured `docker compose` command, smoke-tested on
its slot port, and then promoted by switching the generated nginx upstream.

## Deploy

```bash
deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-control-plane --revision <sha>
```

What it does:

1. determine the current slot
2. select the inactive slot
3. fetch or clone the target app repo into that slot
4. run the configured build commands
5. install any service-profile env files for that app
6. start the slot service
7. health check the slot
8. sync runtime service config where supported
9. switch nginx upstream
10. update `current-slot`
11. refresh `current`
12. install scheduled jobs for the app

## Rollback

```bash
deploy/bin/rollback-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-chat-platform
```

Rollback flips traffic back to the opposite slot and repoints `current`.

## Smoke Test

```bash
deploy/bin/smoke-test-app.sh http://127.0.0.1:3301/api/health
```

## Scheduled Jobs

```bash
deploy/bin/install-scheduled-jobs.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-api
```

## Docker Slot Commands

The example config now models every app as a Docker Compose project with
slot-tokenized commands such as:

- `HOST_PORT=__SLOT_PORT__ ... docker compose --project-name gateway-api-__SLOT__ -f docker-compose.yml up -d --build --remove-orphans`
- `HOST_PORT=__SLOT_PORT__ ... docker compose --project-name gateway-chat-platform-__SLOT__ -f docker-compose.yml up -d --build --remove-orphans`
- `HOST_PORT=__SLOT_PORT__ ... docker compose --project-name gateway-control-plane-__SLOT__ -f docker-compose.yml up -d --build --remove-orphans`

`deploy-app` resolves these tokens per slot:

- `__APP_ID__`
- `__SLOT__`
- `__SLOT_DIR__`
- `__SLOT_PORT__`
- `__DEPLOY_ROOT__`
- `__CURRENT__`
- `__SHARED__`
- `__HEALTH_PATH__`

That is what lets a single config file drive blue/green deployments across all
three repos without hardcoding slot paths into the deploy engine.

## Legacy Control-Plane Service

The generated singleton `gateway-control-plane.service` still exists as an
optional legacy path for development or rescue access. It is not the preferred
production model once the control plane is deployed as a blue/green Docker app.

## Service Artifacts

Build output also includes service-profile artifacts:

- `generated/services/gateway-api/gateway-api.env`
- `generated/services/gateway-chat-platform/chat-api.env`
- `generated/services/gateway-chat-platform/agents.json`

Those files are the control plane's desired-state output for the two current
gateway-managed apps. The admin UI edits the source config for them directly.

`deploy-app.sh` now applies those service-profile artifacts automatically for
matching apps. You can also apply them manually:

```bash
deploy/bin/apply-service-profiles.sh --config configs/gateway.config.json --app gateway-chat-platform --base-url http://127.0.0.1:3301
```

For `gateway-chat-platform`, that command both writes the configured chat API
env file and pushes the configured agents to `/api/agents/manage/sync`.

The generated chat-platform env file also includes the typed local TTS settings
from `serviceProfiles.gatewayChatPlatform.tts`, rendered as:

- `TTS_ENABLED`
- `TTS_BASE_URL`
- `TTS_DEFAULT_VOICE`
- `TTS_GENERATE_PATH`
- `TTS_STREAM_PATH`
- `TTS_VOICES_PATH`
- `TTS_HEALTH_PATH`

The admin UI also lets you:

- browse voices from the live TTS service
- create new voices by uploading reference audio and the matching transcript
- delete obsolete voices
- map a voice to an agent via `endpointConfig.modelParams.ttsVoiceId`

You can also exercise a synced agent directly through the control plane:

```bash
node src/cli.ts run-agent --config configs/gateway.config.json --app gateway-chat-platform --agent bruvie-d --prompt "Give me a quick readiness check."
```

That calls `gateway-chat-platform`'s `POST /api/agents/:id/run` endpoint using
the configured `serviceProfiles.gatewayChatPlatform.apiBaseUrl`.

For `gateway-api`, the admin UI also proxies live workflow CRUD to the
configured `serviceProfiles.gatewayApi.apiBaseUrl`.

To seed migrated workflows into `gateway-api`:

```bash
deploy/bin/import-workflow-seed.sh --base-url http://127.0.0.1:3200
```

The admin UI exposes the same live operations:

- import the bundled OpenClaw workflow seed into `gateway-api`
- sync configured chat agents into `gateway-chat-platform`
- run Bruvie-D or any configured agent through `/api/agents/:id/run`
- configure and probe the external `local-tts-service`

## Per-Repo Auto Deploy

The intended automation model is:

- this repo deploys `gateway-control-plane`
- the `gateway-api` repo deploys `gateway-api`
- the `gateway-chat-platform` repo deploys `gateway-chat-platform`

Each workflow should run on the gateway self-hosted runner and call the live
control-plane checkout on the host:

```bash
/opt/gateway-control-plane/deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app <app-id> --revision "${GITHUB_SHA}"
```
