# Personal Assistant Setup

This setup turns the existing control-plane + gateway-chat stack into a scheduled
personal assistant and execution coach with:

- scheduled morning / midday / evening check-ins
- persistent memory in `goblinsan/notes`
- chat delivery through your public `gateway-chat` endpoint
- local-model handling for routine summaries and accountability
- a separate OpenAI-backed planner for dependency analysis and plan refreshes
- a Postgres-backed dashboard summary in the control-plane overview

## Current Split Of Responsibilities

Use the local assistant for:

- routine check-ins
- progress summaries
- milestone tracking
- short prioritization nudges

Use the OpenAI planner for:

- dependency analysis
- major replanning
- architecture tradeoffs
- deeper schedule / milestone redesign

Current limitation:

- the control-plane can store both agent definitions, but it does not yet do
  intent-based provider switching inside one agent definition. For now, keep a
  paired `personal-assistant` and `expert-planner` agent and switch to the
  planner for deeper analysis.

## 1. Clone The Notes Repo

Example:

```bash
git clone git@github.com:goblinsan/notes.git /srv/notes
```

The runtime user for `gateway-chat-platform` and any scheduled coach job must
be able to:

- read `/srv/notes`
- append files inside `/srv/notes`
- commit and push changes

## 2. Configure Monitoring For Dashboard Storage

The new project-tracking dashboard uses the same Postgres/Redis backend as the
monitoring view. Point `monitoring.postgres` at your core-node Postgres service.

That enables:

- `GET /api/project-tracking/overview`
- `POST /api/project-tracking/projects`
- overview cards and the copy-ready summary block in the admin UI

## 3. Configure Gateway Chat For Scheduled Inbox Delivery

Set these `gatewayChatPlatform.environment` entries in the control-plane:

```text
REDIS_URL=redis://<core-node-ip>:6379
CHAT_DEFAULT_USER_ID=me
CHAT_DEFAULT_CHANNEL_ID=coach
```

Your public chat hostname can stay on the existing `gateway-chat-platform`
app config, for example `chat.jimmothy.site`.

## 4. Create The Agents

Reference files:

- [personal-assistant-agent.json](/Users/jamescoghlan/code/gateway-control-plane/examples/personal-assistant/personal-assistant-agent.json)
- [expert-planner-agent.json](/Users/jamescoghlan/code/gateway-control-plane/examples/personal-assistant/expert-planner-agent.json)

Recommended mapping:

- `personal-assistant` -> local `llm-service` / LM Studio / llama.cpp route
- `expert-planner` -> OpenAI API route

Before importing, edit:

- provider names
- model ids
- `endpointConfig.baseUrl`
- `endpointConfig.apiKey` for OpenAI
- `notesSync.repoPath`

Keep `notesSync` enabled on the personal assistant if you want normal chat
exchanges to append into `goblinsan/notes`.

## 5. Import The Scheduled Workflow Seed

Seed file:

- [personal-assistant-workflows.json](/Users/jamescoghlan/code/gateway-control-plane/examples/personal-assistant/personal-assistant-workflows.json)

CLI example:

```bash
node src/cli.ts import-workflow-seed \
  --base-url http://127.0.0.1:4173 \
  --file examples/personal-assistant/personal-assistant-workflows.json
```

Adjust these inputs after import:

- `agentId`
- `planFilePath`
- `notesRepoPath`
- `threadId`
- `threadTitle`

The seed assumes the existing `gateway-jobs.run / plan_progress_coach` job is
available in `gateway-api`.

## 6. Feed Project State Into The Dashboard

The assistant dashboard becomes useful only when something writes project state
into Postgres. You can push updates from chat handlers, scheduled jobs, or
manual scripts.

Example:

```bash
curl -X POST http://127.0.0.1:4173/api/project-tracking/projects \
  -H 'content-type: application/json' \
  -d '{
    "projectId": "gateway-assistant",
    "name": "Gateway Personal Assistant",
    "status": "on-track",
    "priority": "high",
    "summary": "Scheduled coaching, notes sync, and dashboard ingestion are wired.",
    "nextAction": "Connect chat-driven check-ins to this endpoint after each coaching exchange.",
    "notesRepoPath": "/srv/notes",
    "planFilePath": "/opt/gateway-control-plane/plans/gateway-control-plane-ui-overhaul.yaml",
    "lastCheckInAt": "2026-04-19T12:00:00-04:00",
    "milestones": [
      {
        "id": "coach-seed",
        "title": "Import assistant agents and workflows",
        "status": "done"
      },
      {
        "id": "dashboard",
        "title": "Surface project tracking in overview",
        "status": "done"
      },
      {
        "id": "chat-ingest",
        "title": "Post chat check-ins into project tracking",
        "status": "pending"
      }
    ],
    "update": {
      "source": "manual-bootstrap",
      "kind": "status-update",
      "summary": "Bootstrap completed; chat-to-dashboard ingestion is next."
    }
  }'
```

Once data exists, the control-plane overview shows:

- active / at-risk / stale project counts
- per-project status cards
- a copyable summary block for sharing with ChatGPT

## 7. Suggested Operating Pattern

1. Scheduled workflows write prompts into your chat inbox.
2. You reply in `chat.jimmothy.site`.
3. The personal assistant logs the exchange into `goblinsan/notes`.
4. A follow-up job or webhook posts the distilled status into
   `/api/project-tracking/projects`.
5. The dashboard overview gives you a single copyable state snapshot.
6. When you need deeper planning, continue the thread with `expert-planner`.

## 8. Next Integration Worth Doing

The missing automation loop is chat-to-dashboard ingestion. The fastest path is
to add a small follow-up job in `gateway-api` or `gateway-chat-platform` that
posts each completed coaching summary into `/api/project-tracking/projects`.
