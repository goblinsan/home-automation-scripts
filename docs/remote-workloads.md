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
- `container-service`
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
- `service.env`
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

`container-service` workloads are the general path for long-running remote APIs
such as LLM inference, Whisper/STT, TTS, and computer vision services. They are
deployed directly as Docker Compose services on the selected node and can be:

- assigned to a specific worker with `nodeId`
- switched between `bridge` and `host` networking
- given optional HTTP or TCP health checks
- started, stopped, restarted, and redeployed from the control-plane UI

Manual balancing between nodes is done by changing `nodeId`, applying the
updated config, and then starting the service on the new node. This is the
intended pattern for GPU-bound services that may need to move between hosts as
capacity changes.

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
- `node.host` and the resolved Bedrock port become the upstream relay target

The intended flow is:

1. the Pi proxy service polls the registry from the configured control-plane URL
2. it advertises those worlds on the local Xbox LAN segment
3. on join, it relays the Bedrock UDP session to the real Bedrock server on the worker node

The admin UI can now deploy and restart that Pi proxy service over SSH, using
the same control-plane config that defines the Bedrock worlds it advertises.

The Pi Proxy panel also shows live relay state pulled from `proxy-state.json`,
including the relay mode, active session counts, and per-client activity for
currently connected Bedrock sessions.

The Bedrock tab also exposes live server observability for each deployed world:

- the configured image ref and the image ID the container is actually using
- the latest Bedrock server version detected from container logs
- the last 100 lines of the server log for startup and connection debugging

## Current Use Cases

- KULRS palette/activity job as a scheduled container workload on the core node
- long-running inference APIs such as Gemma, Whisper, TTS, and CV services as `container-service` workloads on GPU-capable nodes
- Minecraft Bedrock worlds as long-running container workloads with admin
  controls and worker-managed update schedules
