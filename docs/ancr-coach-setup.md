# ANCR Coach Setup

This setup gives you a scheduled personal coach around the ANCR 2-week plan in [docs/ancr-2-week-plan.md](./ancr-2-week-plan.md).

What it does now:
- sends morning, midday, and evening coaching check-ins
- reads the ANCR plan plus recent notes from the `notes` repo
- uses a local chat agent for the coaching response
- appends each coaching message into today's note in the `notes` repo
- commits and pushes those note updates

What it does not do yet:
- capture Telegram replies automatically and save them back into notes

Current path for saving your own response:
- use the disabled `ancr-coach-log-progress` workflow
- edit its `progressEntry` input in the admin UI
- click `Run`
- the job appends that entry into the notes repo, commits, pushes, and can optionally send back a short coach reflection

## Expected Paths

The seed file assumes these deployed paths:
- plan file: `/opt/gateway-control-plane/docs/ancr-2-week-plan.md`
- notes repo: `/srv/example-notes`

If your gateway server uses different paths, edit the workflow input after import.

## 1. Clone The Notes Repo On The Gateway

Example:

```bash
git clone https://github.com/goblinsan/notes.git /srv/example-notes
```

Make sure the runtime user for `gateway-api` can:
- read `/srv/example-notes`
- commit inside `/srv/example-notes`
- push from `/srv/example-notes`

## 2. Make Sure The Delivery Channel Exists

The workflow seed uses the job-runtime delivery channel:
- `jim-telegram`

If you use a different channel id, change the imported workflow input.

## 3. Import The Workflow Seed

Seed file:
- [migration/ancr/ancr-coach-workflows.json](/Users/jamescoghlan/code/gateway-control-plane/migration/ancr/ancr-coach-workflows.json)

CLI example:

```bash
node src/cli.ts import-workflow-seed \
  --base-url http://127.0.0.1:3200 \
  --file migration/ancr/ancr-coach-workflows.json
```

Or use the admin UI workflow-seed import and point it at:

```text
migration/ancr/ancr-coach-workflows.json
```

## 4. Confirm The Agent Id

The seed defaults to:
- `bruvie-d`

That is already a local-model agent in the example config. If you want a more specialized project-manager persona, update the imported workflow input to use a different local agent id.

## 5. Daily Use

Scheduled workflows:
- `ancr-coach-morning` at 8:00 AM
- `ancr-coach-midday` at 12:30 PM
- `ancr-coach-evening` at 6:30 PM

Manual progress logging:
1. Open `Automations`
2. Find `ancr-coach-log-progress`
3. Edit `input.progressEntry`
4. Click `Run`

That run will:
- append the progress note into today's note file
- commit and push the notes repo
- optionally send a short reflection back through the configured delivery channel
