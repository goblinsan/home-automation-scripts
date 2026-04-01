# Architecture

This repo models the gateway server as infrastructure, not as a single app.

## Responsibilities

The gateway host is responsible for:

- reverse-proxy ingress
- blue/green slot switching
- release layout under `/srv/apps/<app>/`
- scheduled jobs deployed from source control
- service env/secrets generation for managed apps
- chat-agent configuration for the local AI platform
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

## Managed Service Profiles

The generic app/deploy model is supplemented by service-specific profiles for
the apps that actually run on the gateway today:

- `gateway-api`
- `gateway-chat-platform`

Those profiles let the control plane manage:

- generated `.env` files and secret-bearing variables
- chat-platform agent definitions, including personalities and model routing
- gateway-api workflow definitions through its management API
- service-specific artifacts emitted under `generated/services/`

For `gateway-chat-platform`, the deploy path can also sync those agent
definitions into the running service through its management API.

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

## Admin Surface

The control plane also includes a built-in web UI that edits the same JSON
config file consumed by the CLI.

It is intended for:

- updating route and app definitions
- adjusting job schedules
- enabling or disabling apps, jobs, and feature flags
- saving and rebuilding generated artifacts without hand-editing JSON

The admin surface is also modeled as part of the gateway config:

- bind host and port for the control-plane UI
- nginx route prefix such as `/admin/`
- a generated systemd service for the UI process
- runtime health and artifact status exposed by the UI itself

## Bedrock Console Access

Minecraft Bedrock on Xbox does not reliably discover worlds across subnet
boundaries, so the architecture now includes an external LAN proxy role:

- the Bedrock server runs on a worker node such as `core-node`
- the control plane hosts a live Bedrock server registry from configured
  `serverName` and `worldName` values for running worlds
- a physical Raspberry Pi on the Xbox subnet runs
  `bedrock-lan-proxy.service` and polls that registry
- the Pi advertises LAN-visible worlds locally, then transfers players to the
  real Bedrock target host and port on join

That split keeps Bedrock world hosting on the core node while still giving
consoles a LAN-discovery path on a different network segment.

The Raspberry Pi is now modeled through:

- a regular SSH-managed node entry in `workerNodes`
- the `serviceProfiles.piProxy` profile for the Bedrock LAN proxy service

That lets the control-plane UI manage both the registry contract and the
deployed `bedrock-lan-proxy.service` on the Pi, while Bedrock world hosting
remains on the core node.
