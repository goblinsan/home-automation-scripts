# Deployment

This repo provides generic blue/green deployment wrappers in `deploy/bin/`.

It also manages the gateway control plane itself through a generated systemd
unit for the admin UI, plus service-specific artifacts for `gateway-api` and
`gateway-chat-platform`.

## Deploy

```bash
deploy/bin/deploy-app.sh --config configs/gateway.config.json --app chat-router --revision <sha>
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
deploy/bin/rollback-app.sh --config configs/gateway.config.json --app chat-router
```

Rollback flips traffic back to the opposite slot and repoints `current`.

## Smoke Test

```bash
deploy/bin/smoke-test-app.sh http://127.0.0.1:3001/health
```

## Scheduled Jobs

```bash
deploy/bin/install-scheduled-jobs.sh --config configs/gateway.config.json --app chat-router
```

## Control-Plane Service

Build output includes a generated admin UI unit:

- `generated/systemd/control-plane/gateway-control-plane.service`

Install it on the gateway with:

```bash
deploy/bin/install-control-plane-service.sh --config configs/gateway.config.json
```

That installs the unit described by `gateway.adminUi`, reloads systemd, and
enables the service. The nginx site renderer also adds an admin route such as
`/admin/` when `gateway.adminUi.enabled` is true.

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
