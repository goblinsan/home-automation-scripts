# Gateway Server Deploy Automation Plan

This file contains an updated step-by-step implementation plan for:

- PR automation
- Auto-fixing CI issues
- Auto-merge
- Blue/Green deployment on a gateway server
- Source-controlled scheduled jobs deployed through the same pipeline

---

## Step 1 — Protect main branch

1. Go to GitHub → Settings → Branches or Rulesets
2. Add a rule for `main`
3. Enable:
   - Require pull requests
   - Require status checks:
     - lint
     - typecheck
     - test
     - build
   - Require branches to be up to date
   - Enable auto-merge
4. Protect these paths with stricter review:
   - `.github/workflows/**`
   - `deploy/**`
   - `infra/systemd/**`
   - `infra/cron/**`

---

## Step 2 — Add PR checks workflow

Create `.github/workflows/pr-checks.yml`

Runs:
- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

Purpose:
- prevent broken changes from reaching `main`
- provide the gates required for auto-merge

---

## Step 3 — Add auto-fix workflow

Create `.github/workflows/pr-autofix.yml`

Purpose:
- automatically fix lint and formatting issues
- commit safe fixes back to the PR branch

Allowed auto-fixes:
- `eslint --fix`
- `prettier --write`
- import ordering
- markdown formatting

Do **not** allow automation to modify:
- dependencies
- deployment scripts
- workflow files
- reverse proxy config
- timer/cron definitions unless explicitly intended

---

## Step 4 — Enable auto-merge

When a PR passes all required checks:
- enable auto-merge in GitHub
- optionally require a label such as `automerge-ok`

Recommended policy:
- allow auto-merge for normal app code
- require review for protected infrastructure files

---

## Step 5 — Set up a self-hosted runner on the gateway

On the gateway server:

```bash
mkdir actions-runner && cd actions-runner
# download runner from GitHub
./config.sh
./run.sh
```

Add a label such as:

```text
gateway
```

This runner will execute production deployment steps locally on the gateway.

---

## Step 6 — Create deployment workflow

File: `.github/workflows/deploy-on-merge.yml`

Trigger:
- PR merged into `main`

Runs on:
```text
self-hosted, gateway
```

Executes:
```bash
/srv/deploy/bin/deploy-myapp.sh <commit-sha>
```

Also add:
- workflow concurrency so only one production deploy runs at a time
- a manual rollback workflow

---

## Step 7 — Prepare gateway folder structure

```text
/srv/apps/myapp/
  blue/
  green/
  current-slot
  current
  shared/

/srv/deploy/bin/
  deploy-myapp.sh
  rollback-myapp.sh
  install-scheduled-jobs.sh
  smoke-test-myapp.sh
```

Notes:
- `blue/` and `green/` hold alternate releases
- `current-slot` stores which color is live
- `current` is a stable path or symlink to the active release
- scheduled jobs should target `current`, not hard-coded blue or green paths

---

## Step 8 — Implement the deploy script

Responsibilities:
1. detect current slot
2. pick the opposite slot
3. pull the exact merged commit
4. install dependencies
5. build the app
6. start the app on the inactive slot port
7. run health checks
8. switch proxy traffic
9. update `current-slot`
10. update the stable `current` path
11. install or refresh scheduled jobs from source control
12. verify scheduled jobs are registered
13. leave the previous slot available briefly for rollback

---

## Step 9 — Reverse proxy switching

Recommended model:
- blue = port 3001
- green = port 3002

Options:
- Nginx upstream switch
- Traefik service switch

Recommended:
- route traffic by port
- update upstream target during deployment
- reload proxy only after the new slot passes health checks

---

## Step 10 — Add a health endpoint

Implement:

```http
GET /health
```

Return:

```text
200 OK
```

This endpoint is used by the deploy script before any traffic cutover.

---

## Step 11 — Add smoke tests

Create a script such as:

```bash
/srv/deploy/bin/smoke-test-myapp.sh
```

Checks can include:
- `/health` returns 200
- homepage responds
- API base route responds
- critical assets or routes exist

Run smoke tests:
- directly against the inactive slot before switch
- through the proxy after switch

---

## Step 12 — Implement rollback

Create:

```bash
/srv/deploy/bin/rollback-myapp.sh
```

Responsibilities:
1. detect current slot
2. switch back to previous slot
3. repoint `current`
4. reload proxy
5. confirm health
6. preserve job definitions already sourced from the release repo

Because scheduled jobs target the stable `current` path, rollback also rolls their executed code back automatically.

---

## Step 13 — Add deployment locking

Prevent concurrent deployments with:

```bash
flock
```

Use a lock file inside the deploy script so only one deploy or rollback can run at a time.

Also set GitHub Actions concurrency in the workflow.

---

## Step 14 — Put scheduled jobs in source control

Do **not** manage recurring jobs with manual `crontab -e` edits.

Instead:
- store job definitions in the repo
- deploy them through the same GitHub Actions + gateway deployment flow
- keep them auditable and reproducible

Preferred options:
1. **systemd timers** — recommended on Debian
2. repo-managed files in `/etc/cron.d/` if you specifically want cron

---

## Step 15 — Prefer systemd timers for managed jobs

Recommended repo structure:

```text
infra/
  systemd/
    refresh-cache.service
    refresh-cache.timer
    sync-content.service
    sync-content.timer
scripts/
  jobs/
    refresh-cache.sh
    sync-content.sh
```

Example service:

```ini
[Unit]
Description=Run content sync job

[Service]
Type=oneshot
WorkingDirectory=/srv/apps/myapp/current
ExecStart=/usr/bin/bash /srv/apps/myapp/current/scripts/jobs/sync-content.sh
User=deploy
```

Example timer:

```ini
[Unit]
Description=Run content sync every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

Benefits:
- source controlled
- deployed automatically
- visible with `systemctl list-timers`
- logged with `journalctl`
- compatible with blue/green + rollback through the stable path

---

## Step 16 — If needed, support repo-managed cron jobs

If you want cron specifically, still avoid manual user crontabs.

Use repo files like:

```text
infra/
  cron/
    myapp-jobs
scripts/
  jobs/
    nightly-cleanup.sh
```

Example cron file:

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

*/15 * * * * deploy /srv/apps/myapp/current/scripts/jobs/refresh-cache.sh >> /var/log/myapp-refresh.log 2>&1
0 3 * * * deploy /srv/apps/myapp/current/scripts/jobs/nightly-cleanup.sh >> /var/log/myapp-cleanup.log 2>&1
```

This is acceptable, but systemd timers are still preferred.

---

## Step 17 — Install scheduled jobs during deployment

Add a dedicated script:

```bash
/srv/deploy/bin/install-scheduled-jobs.sh
```

### For systemd timers

Example:

```bash
sudo cp "$RELEASE_DIR/infra/systemd/"*.service /etc/systemd/system/
sudo cp "$RELEASE_DIR/infra/systemd/"*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now refresh-cache.timer
sudo systemctl enable --now sync-content.timer
systemctl list-timers --all | grep -E 'refresh-cache|sync-content'
```

### For cron files

Example:

```bash
sudo cp "$RELEASE_DIR/infra/cron/myapp-jobs" /etc/cron.d/myapp-jobs
sudo chmod 644 /etc/cron.d/myapp-jobs
sudo systemctl reload cron
```

This install step should run **after** successful app deployment and traffic switch.

---

## Step 18 — Split jobs into two categories

### A. Release-coupled jobs
These should follow the deployed app version.

Examples:
- cache warmers
- sync jobs
- scheduled API calls
- content refresh
- model metadata refresh

These should execute from:

```text
/srv/apps/myapp/current/
```

### B. Host-level jobs
These are server operations that should be controlled more carefully.

Examples:
- system backups
- log cleanup
- Docker cleanup
- cert renewal wrappers
- watchdog scripts

These may live in the same repo or a separate infra repo, but they should be treated as protected infrastructure code.

---

## Step 19 — Add AI-assisted repair loop (optional)

Only add this after the deterministic automation is stable.

Rules:
- only fix lint, formatting, import-order, or tightly scoped type issues
- max 2 attempts per PR
- never modify:
  - workflow files
  - deploy scripts
  - systemd timer files
  - cron definitions
  - reverse proxy config
  - secrets handling

If the fix is not safe or not resolved quickly, label the PR for human review.

---

## Step 20 — Final deployment order

Recommended order on merge to `main`:

1. deploy app code to inactive slot
2. build and start new slot
3. run direct health checks
4. run pre-switch smoke tests
5. switch proxy traffic
6. update `current-slot`
7. repoint stable `current` path
8. run post-switch smoke tests
9. install or refresh scheduled jobs from repo
10. reload timer/cron subsystem
11. verify scheduled jobs are registered
12. keep previous slot briefly for rollback

This order ensures scheduled jobs are deployed from source control through the same release process.

---

## Step 21 — Final flow

```text
PR opened
→ checks run
→ auto-fix (if needed)
→ checks pass
→ auto-merge
→ deploy inactive slot
→ health check
→ switch traffic
→ update stable current path
→ install repo-managed scheduled jobs
→ verify timers/cron
→ done
```

---

## Step 22 — Policy statement

```markdown
All scheduled jobs must be defined in source control and deployed through the standard gateway deployment pipeline. Manual server-side crontab edits are not permitted for managed jobs. App-specific recurring tasks should be implemented as repo-managed systemd timers pointing at the stable live release path so that deployments and rollbacks automatically affect scheduled execution behavior.
```

---

## Done

You now have a deployment automation plan that includes:
- CI/CD guardrails
- auto-fix capability
- auto-merge
- blue/green releases
- rollback
- source-controlled scheduled jobs deployed through the same pipeline
