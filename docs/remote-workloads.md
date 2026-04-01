# Remote Workloads

This control plane now supports a second execution plane alongside the gateway host:

- gateway host: ingress, blue/green apps, local systemd jobs
- worker nodes: remote Docker workloads managed over SSH

## Model

The config adds two new top-level sections:

- `workerNodes`
- `remoteWorkloads`

`workerNodes` defines the remote host, its SSH identity, Docker runtime
commands, and where stack/build/volume data live on that machine.

`remoteWorkloads` defines workload bundles that are rendered locally by the
control plane and then copied to a worker node for deployment.

Each worker node also gets a generated `gateway-worker` container runtime. It
evaluates workload schedules in-process and handles Bedrock control actions
without installing host-level timer units or requiring Node on the worker host.

The first supported workload kinds are:

- `scheduled-container-job`
- `minecraft-bedrock-server`

For Bedrock on consoles, `networkMode: "host"` is the recommended setting when
you want LAN discovery to work from Xbox clients. Bridge mode can still be used
for direct UDP exposure, but it is less reliable for console LAN visibility.

## Rendered Bundle

`npm run build` now emits per-node workload bundles under:

```text
generated/nodes/<node-id>/workloads/<workload-id>/
```

Depending on workload kind, the bundle can include:

- `worker/worker-config.json`
- `worker/gateway-worker.mjs`
- `worker/Dockerfile`
- `worker/compose.yml`
- `compose.yml`
- `job.env`
- `Dockerfile`
- `runtime/*.json`
- `scripts/*.sh`

## Deploy Flow

`node src/cli.ts deploy-remote-workload --workload <id>` does the following:

1. renders the latest bundle into `generated/`
2. copies the node worker bundle and workload bundle to the worker node over `scp`
3. prepares source checkout/build state on the worker node
4. builds or starts the remote container workload
5. rebuilds/restarts the `gateway-worker` container so the latest schedules and actions are active

## Bedrock Control

`node src/cli.ts control-minecraft --workload <id> --action <...>` supports:

- `start`
- `stop`
- `restart`
- `broadcast`
- `kick`
- `ban`
- `update-if-empty`

The Bedrock updater is implemented as a generated worker-managed script that
checks for active players before pulling and recreating the server container.

## Pi LAN Proxy Registry

The control plane can also manage a Raspberry Pi node running
`bedrock-lan-proxy.service` on the Xbox subnet.

The Pi is modeled as:

- a node entry in `workerNodes`
- a managed service profile in `serviceProfiles.piProxy`

The control plane exposes a registry endpoint, configured by
`serviceProfiles.piProxy.registryPath`, that lists only running Bedrock worlds.

Each registry record is derived from the Bedrock workload config and live
runtime state:

- `serverName` becomes the advertised Bedrock `motd`
- `worldName` becomes the advertised Bedrock `levelName`
- `node.host` and the resolved Bedrock port become the transfer target

The intended flow is:

1. the Pi proxy service polls the registry from the configured control-plane URL
2. it advertises those worlds on the local Xbox LAN segment
3. on join, it transfers the player to the real Bedrock server on the worker node

The admin UI can now deploy and restart that Pi proxy service over SSH, using
the same control-plane config that defines the Bedrock worlds it advertises.

## Current Use Cases

- KULRS palette/activity job as a scheduled container workload on the core node
- Minecraft Bedrock worlds as long-running container workloads with admin
  controls and worker-managed update schedules
