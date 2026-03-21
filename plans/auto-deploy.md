# Gateway Server Auto-Deploy Plan (GitHub Actions + Auto-Fix + Blue/Green)

## Goal

Create a mostly self-driving delivery flow where:

1. Pull requests run automated checks.
2. Trivial failures like lint/format issues can be fixed automatically.
3. PRs can be auto-merged when policy is satisfied.
4. A merge to `main` triggers deployment to the gateway server.
5. Deployment uses a blue/green-style swap with health checks and rollback.
6. Risky steps still have guardrails so the repo does not silently drift into bad state.

GitHub supports running workflows on PR events and on merged PRs via the `pull_request` event with `types: [closed]` and a condition that checks whether the PR was actually merged. GitHub also supports rulesets/branch protections, merge queues, environments, and self-hosted runners, which fit this design well. :contentReference[oaicite:0]{index=0}

---

## Recommended architecture

### Control plane
- **GitHub Actions** orchestrates CI, auto-fix, merge gating, and deploy triggers.
- **GitHub branch rules / rulesets** protect `main`.
- **GitHub merge queue** is optional but recommended if multiple PRs may merge close together. :contentReference[oaicite:1]{index=1}

### Execution plane
- **Gateway server** runs the actual app instances.
- **Reverse proxy** on gateway routes traffic to either blue or green.
- **Deployment script** on gateway performs pull/build/start/health-check/swap/rollback.
- **Self-hosted runner** on the gateway is the cleanest path if you want GitHub Actions to trigger deployment locally. GitHub documents self-hosted runners as a supported Actions model. :contentReference[oaicite:2]{index=2}

### AI-assisted repair loop
- A PR workflow detects failures.
- For safe categories only, automation attempts to fix and push changes back to the PR branch.
- For broader issues, use Copilot coding agent or a CLI-based fixer flow to make a follow-up commit or PR update. GitHub documents that Copilot coding agent can make changes to an existing PR, and their Copilot guidance explicitly includes fixing lint errors and diagnosing test failures. :contentReference[oaicite:3]{index=3}

---

## High-level workflow

```text
feature branch / copilot branch
        ↓
PR opened
        ↓
CI runs:
- install
- lint
- typecheck
- unit/integration tests
- build
        ↓
If safe failure type:
- auto-fix workflow runs
- pushes fix commit to PR branch
- CI reruns
        ↓
If checks pass:
- PR marked eligible for merge
- optional merge queue
- auto-merge enabled
        ↓
PR merges to main
        ↓
deploy workflow fires
        ↓
gateway self-hosted runner calls deploy script
        ↓
green slot updated
        ↓
health checks pass
        ↓
reverse proxy switches traffic
        ↓
old blue slot retained briefly for rollback

-----

## Opinionated recommendation

Use this stack first:

- GitHub Actions for CI/CD orchestration
- GitHub self-hosted runner on the gateway
- Node/TypeScript deploy orchestration script if your ecosystem is already TS-heavy
- Docker Compose or systemd units for blue/green app slots
- Nginx or Traefik as the traffic switch layer
- GitHub rulesets + required status checks + optional merge queue

This is the fastest path because:

- it aligns with the rest of your TS-based tooling,
- Copilot tends to be strongest in common GitHub Actions + Node/TS workflows,
- and you avoid inventing a custom webhook receiver before you need one.


-----

