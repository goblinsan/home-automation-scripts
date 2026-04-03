# Core Node Summary Template

This tracked file is a template only.

Do not commit the real details of your core service node here. Keep those in an
untracked local note under `docs/local/`.

## Recommended local-only file

```text
docs/local/core-node-summary.md
```

## Safe tracked guidance

Use the core node summary to capture publish-safe design intent:

- role separation between gateway and core service node
- what classes of services belong on the core node
- storage strategy patterns
- backup and observability expectations

## Suggested private sections

Keep these in the local-only copy:

- exact hardware inventory
- disk names and mount points
- internal hostnames and IPs
- local service paths
- current running services
- node-specific constraints and maintenance notes

## Typical core-node responsibilities

- always-on internal APIs
- databases and queues
- automation services
- persistent Docker volumes
- backup targets
- light GPU-assisted utility jobs when available
