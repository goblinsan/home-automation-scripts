# Architecture

This repo models the gateway server as infrastructure, not as a single app.

## Responsibilities

The gateway host is responsible for:

- reverse-proxy ingress
- blue/green slot switching
- release layout under `/srv/apps/<app>/`
- scheduled jobs deployed from source control
- CI/CD execution via a self-hosted runner

## Release Layout

Each app deployed through the gateway follows this structure:

```text
/srv/apps/<app>/
  blue/
  green/
  current-slot
  current
  shared/
```

`current` is a stable symlink to the active slot, and scheduled jobs must point
at that stable path rather than a hard-coded color.

## Routing Model

The reverse proxy layer is generic.

Each app has:

- a route definition
- blue and green ports
- an active upstream include file

The control-plane CLI renders nginx config from the gateway config file and the
deploy tooling swaps active upstreams only after health checks pass.

## Scheduled Jobs

Jobs are defined in source control and rendered into host `systemd` service and
timer units.

Each job references:

- the owning app id
- a systemd schedule
- a working directory
- an executable command
- the runtime user

The CLI resolves `__CURRENT__` placeholders to `/srv/apps/<app>/current`, so
rollback changes both traffic routing and scheduled job code paths together.

