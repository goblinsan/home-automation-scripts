# OpenClaw Migration

This directory captures the first migration pass from the old OpenClaw setup
into the `gateway-control-plane` model.

## Bruvie-D

`bruvie-d-agent.json` is the migrated assistant agent definition derived from:

- `gateway-chat-platform/migration/IDENTITY.md`
- `gateway-chat-platform/migration/SOUL.md`
- `gateway-chat-platform/migration/USER.md`
- `gateway-chat-platform/migration/TRAINING.md`

It is also reflected in `configs/gateway.config.example.json`.

The model choice here is an inference from the existing chat-platform examples:

- provider: `lm-studio-a`
- model: `qwen/qwen3-32b`
- endpoint: `http://198.51.100.172:1234`

If the LM Studio host at `198.51.100.172` is serving a different model ID, only
the `model` field needs to change.

## Workflow Seed

`gateway-api-workflows.json` is a curated workflow seed derived from
`gateway-api/migration/jobs.json`.

What it does:

- carries over the assistant-oriented jobs as workflow records
- preserves the old prompt text inside `input.prompt`
- marks the clearly OpenClaw-specific host jobs as disabled legacy records

Legacy-disabled workflows:

- `yahoo-triage-quarter-hour`
- `tts-on-morning`
- `tts-off-morning`
- `tts-on-midday`
- `tts-off-evening`

Those need a new execution target in the gateway runtime before they should be
re-enabled.

## Import

Once `gateway-api` is running and reachable:

```bash
deploy/bin/import-workflow-seed.sh \
  --base-url http://127.0.0.1:3000 \
  --file migration/openclaw/gateway-api-workflows.json
```

The import is idempotent by workflow name:

- existing names are updated
- missing names are created
