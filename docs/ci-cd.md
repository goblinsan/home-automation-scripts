# CI/CD

The intended CI/CD model is:

- pull requests run repo checks
- safe autofixes can update the PR branch
- merges to `main` trigger a gateway deployment workflow
- the gateway workflow runs on a self-hosted runner on the gateway server

The important detail is that deployments must use the live gateway config on
the host, not the ephemeral Actions checkout, because the host config contains
gateway-specific routes, ports, and secrets.

## Self-Hosted Runner

Install a GitHub Actions self-hosted runner on the gateway and label it:

- `self-hosted`
- `gateway`

That runner needs Docker, nginx, Node 24, and access to:

- `/opt/gateway-control-plane`
- `/opt/gateway-api`
- `/opt/gateway-chat-platform`
- `/srv/apps/*`

## Repo Responsibilities

Each repo owns deploying its own app:

- `gateway-control-plane` deploys app id `gateway-control-plane`
- `gateway-api` deploys app id `gateway-api`
- `gateway-chat-platform` deploys app id `gateway-chat-platform`

All three repos should call the same live deploy wrapper on the host:

```bash
/opt/gateway-control-plane/deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app <app-id> --revision "${GITHUB_SHA}"
```

## This Repo's Workflow

This repo's built-in `deploy-on-merge.yml` now deploys `gateway-control-plane`
using the host config at `/opt/gateway-control-plane/configs/gateway.config.json`.

The rollback workflow is intentionally generic and can target any configured app
id, but defaults to `gateway-control-plane`.

## Companion Repo Workflow Shape

The companion repos should add equivalent workflows that differ only by app id.

For `gateway-api`:

```yaml
name: Deploy On Merge

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: [self-hosted, gateway]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm run build
      - run: /opt/gateway-control-plane/deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-api --revision "${GITHUB_SHA}"
```

For `gateway-chat-platform`:

```yaml
name: Deploy On Merge

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: [self-hosted, gateway]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: corepack enable
      - run: corepack prepare pnpm@latest --activate
      - run: pnpm install
      - run: pnpm --filter @gateway/chat-ui typecheck
      - run: /opt/gateway-control-plane/deploy/bin/deploy-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-chat-platform --revision "${GITHUB_SHA}"
```

## Rollback

Any rollback can be triggered from this repo's workflow or directly on the
gateway host:

```bash
/opt/gateway-control-plane/deploy/bin/rollback-app.sh --config /opt/gateway-control-plane/configs/gateway.config.json --app gateway-chat-platform
```
