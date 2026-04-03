# GPU Node Summary Template

This tracked file is a template only.

Keep real node details such as:

- hostnames
- LAN IPs
- SSH usernames
- storage mount points
- hardware inventory
- model cache locations

in an untracked local note under `docs/local/`.

## Recommended local-only file

```text
docs/local/gpu-node-summary.md
```

## What to track here

Only track stable, reusable planning guidance that is safe to publish.

### Suggested workload classes

- small LLM inference
- speech-to-text / diarization
- text-to-speech
- computer vision inference

### Suggested control-plane shape

- add the node under `workerNodes`
- model long-running inference APIs as `remoteWorkloads` with kind `container-service`
- mount model caches from a node-local data root
- expose a health endpoint for each service
- move a service between nodes by changing `nodeId` and redeploying

### Suggested local-only fields

When you write the private version, include placeholders like:

```json
{
  "id": "<gpu-node-id>",
  "host": "<lan-ip>",
  "sshUser": "<ssh-user>",
  "buildRoot": "<build-root>",
  "stackRoot": "<stack-root>",
  "volumeRoot": "<volume-root>"
}
```
