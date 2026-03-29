# Remote Workloads

This control plane now supports a second execution plane alongside the gateway host:

- gateway host: ingress, blue/green apps, local systemd jobs
- worker nodes: remote Docker workloads managed over SSH

## Model

The config adds two new top-level sections:

- `workerNodes`
- `remoteWorkloads`

`workerNodes` defines the remote host, its SSH identity, Docker and worker
runtime commands, and where stack/build/volume data live on that machine.

`remoteWorkloads` defines workload bundles that are rendered locally by the
control plane and then copied to a worker node for deployment.

Each worker node also gets a generated `gateway-worker` runtime that runs as a
regular user. It evaluates workload schedules in-process and handles Bedrock
control actions without installing host-level timer units.

The first supported workload kinds are:

- `scheduled-container-job`
- `minecraft-bedrock-server`

## Rendered Bundle

`npm run build` now emits per-node workload bundles under:

```text
generated/nodes/<node-id>/workloads/<workload-id>/
```

Depending on workload kind, the bundle can include:

- `worker/worker-config.json`
- `worker/gateway-worker.mjs`
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
5. restarts the user-space `gateway-worker` so the latest schedules and actions are active

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

## Current Use Cases

- KULRS palette/activity job as a scheduled container workload on the core node
- Minecraft Bedrock worlds as long-running container workloads with admin
  controls and worker-managed update schedules
