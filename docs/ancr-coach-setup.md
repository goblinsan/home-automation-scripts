# ANCR Coach Setup

This setup gives you a scheduled personal coach around the ANCR 2-week plan in [docs/ancr-2-week-plan.md](./ancr-2-week-plan.md).

What it does now:
- sends morning, midday, and evening coaching check-ins
- reads the ANCR plan plus recent notes from the `notes` repo
- uses a local chat agent for the coaching response
- publishes scheduled coach prompts into the `gateway-chat` inbox
- appends each coaching message into today's note in the `notes` repo
- commits and pushes those note updates

What it does now for `gateway-chat`:
- you can talk to a dedicated coach agent in `gateway-chat`
- scheduled coach prompts land in the chat inbox for the configured `userId` / `channelId`
- each coach exchange can be appended into the `notes` repo and pushed automatically

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

## 2. Point Gateway Chat At Redis

Add these env vars to the `gateway-chat-platform` service profile:

```text
REDIS_URL=redis://<core-node-ip>:6379
CHAT_DEFAULT_USER_ID=me
CHAT_DEFAULT_CHANNEL_ID=coach
```

That gives `gateway-chat` a durable inbox for scheduled prompts.

## 3. Create The Coach Agent In Gateway Chat

Reference config:
- [examples/ancr/ancr-coach-agent.json](/Users/jamescoghlan/code/gateway-control-plane/examples/ancr/ancr-coach-agent.json)

Use the `AI Agents` tab in the control-plane admin UI and create an agent based on that file.

Important piece:
- `endpointConfig.modelParams.notesSync`

That is what causes normal `gateway-chat` conversations with the coach agent to:
- append the exchange into `/srv/example-notes`
- commit the notes repo
- push the repo

If you prefer to reuse `bruvie-d` instead of a dedicated coach agent, copy the same `notesSync` block into Bruvie-D's `endpointConfig.modelParams`.

## 4. Import The Workflow Seed

Seed file:
- [examples/ancr/ancr-coach-workflows.json](/Users/jamescoghlan/code/gateway-control-plane/examples/ancr/ancr-coach-workflows.json)

CLI example:

```bash
node src/cli.ts import-workflow-seed \
  --base-url http://127.0.0.1:3200 \
  --file examples/ancr/ancr-coach-workflows.json
```

Or use the admin UI workflow-seed import and point it at:

```text
examples/ancr/ancr-coach-workflows.json
```

## 5. Confirm The Scope

The seed defaults to:
- `userId = "me"`
- `channelId = "coach"`
- `threadId = "ancr-coach-me"`

You can change those in the imported workflow input later, but keep them stable if you want all coach prompts and replies to stay in the same scoped thread.

## 6. Daily Use

Scheduled workflows:
- `ancr-coach-morning` at 8:00 AM
- `ancr-coach-midday` at 12:30 PM
- `ancr-coach-evening` at 6:30 PM

These scheduled runs now do both:
- write the coach guidance into the `notes` repo and push it
- publish the same check-in into the `gateway-chat` inbox

Interactive coaching:
1. Open `gateway-chat`
2. Open the `Inbox` panel and click the coach prompt
3. Talk to the `ancr-coach` agent in that thread
3. If `notesSync` is configured on that agent, each exchange is appended into the notes repo automatically

Manual progress logging:
1. Open `Automations`
2. Find `ancr-coach-log-progress`
3. Edit `input.progressEntry`
4. Click `Run`

That run will:
- append the progress note into today's note file
- commit and push the notes repo
- optionally add a short coach reflection into the notes file
- publish that reflection into the `gateway-chat` inbox when `inbox` is configured
