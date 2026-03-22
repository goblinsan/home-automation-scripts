# Gateway Control Plane

This repo is the gateway-server control plane.

It exists to define and maintain:

- reverse-proxy routing on the gateway host
- blue/green deployment mechanics for apps deployed on the gateway
- source-controlled scheduled jobs
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

## Repo Layout

```text
.
├── configs/
│   └── gateway.config.example.json
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
│   └── ci-cd.md
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
```

## What The Build Produces

`npm run build` renders example gateway artifacts into `generated/`:

- `generated/nginx/gateway-site.conf`
- `generated/nginx/upstreams/<app>-blue.conf`
- `generated/nginx/upstreams/<app>-green.conf`
- `generated/systemd/jobs/*.service`
- `generated/systemd/jobs/*.timer`

These are generated from `configs/gateway.config.example.json`.

## Admin UI

This repo also includes a built-in admin UI for editing the gateway config file.
It exposes the same config shape used by the CLI, including:

- gateway settings
- apps and blue/green slot commands
- scheduled job timings
- feature enable/disable flags

Run it with:

```bash
npm run ui
```

Then open `http://127.0.0.1:4173`.

## Next Host Setup

If you already tried the previous Python/HA-oriented setup on the server, do not
continue with it. Use the cleanup notes in [docs/bootstrap.md](docs/bootstrap.md)
before provisioning the clean-slate gateway host layout.
