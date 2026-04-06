# Documentation Review Notes

This note captures suggested improvements for the Copilot-generated docs so they
better match the implemented control-plane behavior and keep the public/private
documentation boundary clear.

## Goals

- Keep public docs accurate to the current implementation
- Avoid presenting conventions as hard platform contracts unless the code
  actually enforces them
- Keep sensitive operational details in `docs/local/`
- Make agent entry docs point at the real source files

## Recommended Edits

### `docs/service-contract.md`

Suggested change:
- Rename the document from `Service Contract` to `Blue/Green App Contract`

Reason:
- The current text reads like a universal contract for every managed service,
  but the actual code distinguishes between blue/green apps, scheduled jobs,
  remote workloads, and service profiles.

Suggested content changes:
- Replace the current "Required: Docker Compose" section with a command-driven
  description of what the deploy system actually requires:
  - `repoUrl`
  - `deployRoot`
  - `healthPath`
  - `buildCommands`
  - `slots.blue.startCommand`
  - `slots.blue.stopCommand`
  - `slots.green.startCommand`
  - `slots.green.stopCommand`
- Explicitly say that Docker Compose, `HOST_PORT`, and a repo-root
  `docker-compose.yml` are the current house style for the gateway-managed apps,
  not a universal control-plane requirement.
- Clarify that env-file token usage such as `__SHARED__` is supported by the
  deploy system, but specific env-file layouts are service-profile conventions.
- Split upstream app API paths from control-plane proxy paths. Example:
  - upstream chat-platform path: `/api/providers/status`
  - control-plane browser/API path: `/api/chat-platform/providers/status`
- Soften this claim:
  - "Each app's `.github/copilot-instructions.md` contains..."
- Replace it with:
  - "Where present, repo-level Copilot/Codex instructions should be treated as
    part of the coordination contract."

Suggested replacement framing:

```md
## 1. What The Control Plane Actually Requires

For a blue/green managed app, the control plane requires a config entry that
provides:

- `repoUrl`
- `deployRoot`
- `healthPath`
- `buildCommands`
- `slots.blue.startCommand`
- `slots.blue.stopCommand`
- `slots.green.startCommand`
- `slots.green.stopCommand`

The deploy engine is command-driven. It does not inherently require Docker
Compose, `HOST_PORT`, or a specific repo layout. Those are the current house
conventions used by the gateway-managed apps.
```

Suggested follow-up section:

```md
## 2. Current House Style For Gateway Apps

The current gateway apps use:

- a repo-root `docker-compose.yml`
- slot commands that pass `HOST_PORT=__SLOT_PORT__`
- env files from `__SHARED__`

Follow that pattern for consistency unless you have a reason not to.
```

### `docs/monitoring.md`

Reason:
- The monitoring subsystem is real, but the current doc claims more coverage
  than the running implementation provides.

Suggested content changes:
- Limit the active probe target list to what is currently built:
  - worker nodes
  - apps
  - remote workloads
- Remove `service profiles` from the current monitoring target list unless and
  until they are actually included in `buildMonitoringTargets()`.
- Remove `service-profile` from the health table explanation unless it is
  intentionally reserved for future use and labeled that way.
- Replace the retention section with wording that matches the code: a purge
  helper exists, but it is not currently wired into the running collector.
- Tighten benchmark wording so it describes the current manual benchmark
  storage/UI, not a broader automated performance framework.

Suggested replacement for retention:

```md
## Data Retention

A purge helper exists in the codebase, but old health rows are not currently
purged automatically by the running collector. If retention becomes necessary,
this should be wired into a scheduled maintenance path.
```

Suggested benchmark framing:

```md
## Benchmark System

The control plane includes manual storage and comparison support for benchmark
runs and benchmark results. It does not currently run benchmarks automatically;
it records runs supplied through the admin UI or API.
```

### `docs/intent.md`

Reason:
- This is the strongest of the public docs, but one section should be tightened
  so it stays aligned with the actual monitoring implementation.

Suggested content changes:
- In the monitoring principle, remove `Service profiles (API reachability)` from
  the list of currently monitored targets.
- Soften this claim:
  - "Each repo has a `.github/copilot-instructions.md`..."
- Replace it with:
  - "Related repos may include `.github/copilot-instructions.md` files
    documenting coordination expectations."

### `.github/copilot-instructions.md`

Reason:
- This file is useful as the agent entrypoint, but one key file reference is
  stale and should point future agents at the real implementation files.

Suggested content changes:
- Replace `src/lib/workers.ts` with:
  - `src/lib/remote-worker.ts`
  - `src/lib/remote-workloads.ts`
- Add a short warning near the top:

```md
Public docs describe stable architecture and contracts.
`docs/local/` contains live operational detail and may drift; treat it as
situational context, not schema.
```

## Local-Only Doc Improvements

These are safe to keep in `docs/local/`, but they should better distinguish
between live facts, planned work, and assumptions that may drift over time.

### `docs/local/topology.md`

Suggested content changes:
- Add a short metadata block at the top:
  - `Last verified: YYYY-MM-DD`
  - `Purpose: live operator context`
  - `May drift from config/runtime`
- Mark future or intended workloads separately from currently deployed
  workloads.
- In the GPU node section, distinguish:
  - hardware facts
  - current config identity
  - planned services

### `docs/local/integrations.md`

Suggested content changes:
- Change the `tags-node` section heading from active language to planned
  language unless those services are actually deployed:
  - `GPU inference services` -> `Planned GPU inference services`
- Fix the monitoring section to remove:
  - service-profile probes as current monitoring targets
  - automatic retention purge as current runtime behavior
- Clarify provider endpoint wording:
  - if referring to the chat-platform upstream API, use `/api/providers/status`
  - if referring to the control-plane browser/API path, use
    `/api/chat-platform/providers/status`

## Suggested Priority Order

1. Fix `docs/service-contract.md`
2. Fix `docs/monitoring.md`
3. Update `.github/copilot-instructions.md`
4. Make the small wording cleanup in `docs/intent.md`
5. Tighten `docs/local/topology.md` and `docs/local/integrations.md`

## Summary

The public docs are directionally useful and mostly safe from a security
standpoint. The main issue is accuracy drift: some sections describe the
intended architecture more broadly than the code actually implements today.
These edits would make the docs more trustworthy for future agents and reduce
the risk of bad assumptions during automation work.
