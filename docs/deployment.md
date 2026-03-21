# Deployment

This repo provides generic blue/green deployment wrappers in `deploy/bin/`.

## Deploy

```bash
deploy/bin/deploy-app.sh --config configs/gateway.config.json --app chat-router --revision <sha>
```

What it does:

1. determine the current slot
2. select the inactive slot
3. fetch or clone the target app repo into that slot
4. run the configured build commands
5. start the slot service
6. health check the slot
7. switch nginx upstream
8. update `current-slot`
9. refresh `current`
10. install scheduled jobs for the app

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

