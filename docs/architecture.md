# System Architecture

This document describes how the **home-automation-scripts** components fit
together across two layers:

- the gateway runtime layer (`nginx` + `systemd` + Dockerized app slots)
- the automation tooling layer (`scripts/`, `tools/`, registry-driven tasks)

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Directory Layout](#directory-layout)
3. [Gateway Runtime Layer](#gateway-runtime-layer)
4. [Automation Tooling Layer](#automation-tooling-layer)
5. [Data Flow](#data-flow)
6. [Secrets Strategy](#secrets-strategy)
7. [Logging Strategy](#logging-strategy)
8. [Extension Points](#extension-points)

---

## High-Level Overview

```text
                Public / LAN traffic
                        |
                        v
                 nginx on the host
                        |
                        v
            active upstream: blue or green
                 /                     \
                v                       v
  gateway-blue.service          gateway-green.service
        docker run                     docker run
  home-automation-gateway:blue  home-automation-gateway:green

    Host-side automation CLI / runner / registry / scripts / cron installer
    remain in the repo as operational tooling alongside the gateway runtime
```

---

## Directory Layout

```
home-automation-scripts/
├── gateway/               # Gateway app and Docker image build assets
│   ├── app.py
│   ├── Dockerfile
│   └── requirements.txt
│
├── deploy/                # Blue-green deployment helpers for the gateway
│   ├── deploy.sh
│   ├── rollback.sh
│   └── smoke_test.sh
│
├── ops/                   # Host-level nginx and systemd assets
│   ├── nginx/
│   ├── state/
│   └── systemd/
│
├── scripts/               # Automation task scripts
│   ├── github_helper.py
│   ├── health_check.py
│   ├── log_rotation.py
│   └── package_update_notifier.py
│
├── configs/               # Non-secret configuration files and templates
│   ├── crontab.example    # Cron job template
│   └── tools_registry.yaml # Tool registry (defines the automation catalogue)
│
├── tools/                 # Internal helper utilities
│   ├── automation.py      # CLI: registry-driven tool runner
│   ├── cron_installer.py  # CLI: installs / removes managed cron entries
│   ├── env_loader.py      # Loads and validates .env variables
│   ├── logger.py          # Centralised logging setup
│   ├── registry.py        # Loads tools_registry.yaml
│   └── runner.py          # CLI: file-discovery task runner
│
├── docs/                  # Documentation and runbooks
│   ├── adding_tools.md
│   ├── architecture.md    # ← this document
│   ├── credentials.md
│   ├── cron_jobs.md
│   ├── installation.md
│   └── usage.md
│
├── .env.example           # Committed placeholder – documents required variables
├── .env                   # NOT committed – your local secrets (gitignored)
├── secrets/               # NOT committed – credential files (gitignored)
└── logs/                  # NOT committed – runtime log files (gitignored)
```

---

## Gateway Runtime Layer

The gateway deployment model is:

- `nginx` on the host handles ingress and active-slot switching.
- `systemd` manages two long-lived slot services.
- Each slot service runs a different Docker image tag.
- `deploy/deploy.sh` rebuilds only the inactive slot tag and cuts traffic over
  after health checks.

Key files:

| Path | Purpose |
|------|---------|
| `gateway/Dockerfile` | Immutable app image build |
| `ops/systemd/gateway-blue.service` | Blue slot container unit |
| `ops/systemd/gateway-green.service` | Green slot container unit |
| `ops/systemd/timers/` | Source-controlled host timer units |
| `deploy/deploy.sh` | Build, restart, health-check, and cut over |
| `deploy/rollback.sh` | Restore traffic to the other slot |
| `deploy/smoke_test.sh` | Direct and proxied `/health` checks |
| `deploy/install_scheduled_jobs.sh` | Render, install, and enable managed timers |

## Automation Tooling Layer

### `scripts/`

Each file in `scripts/` is an independent Python module that implements one
automation task. The only contract required by the runner is:

1. The file must expose a module-level `run()` callable.
2. Optionally, a `DESCRIPTION` string is used for task listings.

Scripts import shared utilities (`tools.logger`, `tools.env_loader`) via
`sys.path` manipulation at the top of the file so they work whether invoked
directly or through the runner.

### `configs/`

Non-secret configuration that *is* committed to the repository:

| File | Purpose |
|------|---------|
| `tools_registry.yaml` | The catalogue of registered automation tools. Read by `tools/registry.py`. |
| `crontab.example` | Cron job template with `$REPO_ROOT` and `$PYTHON` placeholders. Read by `tools/cron_installer.py`. |

### `tools/runner.py`

The **file-discovery runner** scans the `scripts/` directory at startup and
imports every `*.py` file that is not prefixed with `_`.  A file is treated as
a valid task if it exposes a `run()` callable at module level.

Key responsibilities:

- `discover_tasks()` — scans `scripts/`, imports modules, returns a dict
  `{task_name: module}` where `task_name` is the filename stem.
- `list_tasks()` — prints a formatted table of task names and descriptions.
- `run_task()` — executes `module.run()`, catches all exceptions, logs them,
  and returns a boolean indicating success.
- CLI commands: `list`, `run <task> [task …]`.

### `tools/automation.py`

The **registry-driven automation CLI**.  It delegates task discovery to
`tools/registry.py` and task execution to `tools/runner.run_task()`.

Differences from the runner:

| | `automation.py` | `runner.py` |
|-|----------------|------------|
| Discovery | Registry (`tools_registry.yaml`) | Filesystem scan of `scripts/`) |
| Task name | `name` field in registry (e.g. `health-check`) | Filename stem (e.g. `health_check`) |
| Enable/disable | `enabled` flag in registry | N/A |

### `tools/registry.py`

Loads `configs/tools_registry.yaml` using PyYAML and returns a list of
`ToolEntry` dataclasses.  The `discover_registered_tools()` function filters
for enabled tools, imports each script, and returns `{name: module}`.

The registry description field is written onto `module.DESCRIPTION` so that
`runner.list_tasks()` can display it without re-reading the YAML file.

### `tools/env_loader.py`

Manages all credential and configuration values stored in the `.env` file:

1. `load_env()` — calls `python-dotenv` to read the `.env` file into
   `os.environ`.  Auto-discovers the file by looking in the repository root
   first, then the current working directory.
2. `require_env(variables)` — calls `load_env()` then asserts that every
   listed variable is present and non-empty; raises `RuntimeError` otherwise.
3. CLI mode — validates named variables and prints `****` (never the real
   value) to confirm they are set.

Scripts call `require_env` at the start of `run()` so that missing credentials
are caught immediately with a clear error message, rather than failing deep
inside the automation logic.

### `tools/cron_installer.py`

Manages a clearly delimited *managed block* inside the user's crontab:

```
# BEGIN home-automation-scripts managed block
…
# END home-automation-scripts managed block
```

Workflow:

1. `load_template()` reads `configs/crontab.example` and substitutes
   `$REPO_ROOT` and `$PYTHON`.
2. `extract_entries()` strips comment and blank lines to get the cron entries.
3. `read_current_crontab()` reads the existing crontab via `crontab -l`.
4. `remove_managed_block()` strips any previously installed block (idempotency).
5. `build_managed_block()` wraps the new entries in the marker comments.
6. `write_crontab()` writes the result back via `crontab -`.

All changes can be previewed without applying them by passing `--dry-run`.

### `tools/logger.py`

Returns a `logging.Logger` configured with:

- A **console (stderr) handler** at `INFO` level for interactive feedback.
- A **file handler** at `DEBUG` level that writes to
  `logs/<name>_<YYYYMMDD_HHMMSS_ffffff>.log`.

The `logs/` directory is created automatically.  Calling `get_logger` with the
same name more than once in a process returns the same logger without adding
duplicate handlers.

---

## Data Flow

### Running a Task via the Automation CLI

```
User
  │
  │  python3 tools/automation.py run health-check
  ▼
tools/automation.py
  │  calls discover_registered_tools()
  ▼
tools/registry.py
  │  reads configs/tools_registry.yaml
  │  imports scripts/health_check.py
  │  returns {"health-check": <module>}
  ▼
tools/runner.run_task("health-check", …)
  │  calls module.run()
  ▼
scripts/health_check.run()
  │  calls require_env([…])  ──►  tools/env_loader.py  ──►  .env
  │  calls get_logger(…)     ──►  tools/logger.py      ──►  logs/*.log
  │  collects metrics and logs them
  ▼
Exit code 0 (success) or 1 (failure)
```

### Running a Task via the Runner CLI

```
User
  │
  │  python3 tools/runner.py run health_check
  ▼
tools/runner.py
  │  calls discover_tasks()
  │  scans scripts/*.py, imports each, keeps those with run()
  │  returns {"health_check": <module>, …}
  │
  │  calls run_task("health_check", …)
  ▼
scripts/health_check.run()
  │  (same as above)
```

### Credential Loading

```
scripts/any_script.py
  │
  │  from tools.env_loader import require_env
  │  env = require_env(["API_KEY", "HOST"])
  ▼
tools/env_loader.load_env()
  │  python-dotenv reads .env from repo root
  │  merges into os.environ (without overwriting existing exports)
  ▼
tools/env_loader.require_env()
  │  checks each variable is present and non-empty
  │  raises RuntimeError listing missing variables if any
  ▼
returns {"API_KEY": "…", "HOST": "…"}
```

### Cron Job Installation

```
User
  │
  │  python3 tools/cron_installer.py install
  ▼
tools/cron_installer.py
  │  load_template(configs/crontab.example)
  │    substitutes $REPO_ROOT and $PYTHON
  │  extract_entries() → list of cron lines
  │  read_current_crontab() via `crontab -l`
  │  remove_managed_block() from existing crontab
  │  build_managed_block() wraps new entries in markers
  │  write_crontab() via `crontab -`
  ▼
User's crontab now contains the managed block.
Cron daemon runs entries on schedule → invokes automation CLI or runner.
```

---

## Secrets Strategy

Secrets are kept out of the repository through three complementary mechanisms:

| Mechanism | Description |
|-----------|-------------|
| `.gitignore` | Permanently excludes `.env`, `secrets/`, `logs/`, key files (`*.key`, `*.pem`, etc.). |
| `.env.example` | Committed placeholder template that documents required variables without real values. |
| `tools/env_loader.py` | Loads secrets at runtime from `.env` into `os.environ`; never writes them to disk or logs. |

Scripts never hard-code credentials.  They call `require_env()` at the start
of `run()` so that a missing secret causes an immediate, descriptive error
rather than a cryptic failure deep in the automation logic.

See [credentials.md](credentials.md) for the full credential configuration
guide.

---

## Logging Strategy

All tools use `tools/logger.get_logger(name)` which provides:

- **Console output** — `INFO` and above, suitable for interactive runs and cron
  email notifications.
- **File output** — `DEBUG` and above, written to
  `logs/<name>_<timestamp>.log`.

Log files are created per run (timestamped filenames), so old logs accumulate.
The `log-rotation` tool (`scripts/log_rotation.py`) prunes files older than a
configurable retention period to prevent the `logs/` directory from growing
unbounded.

Log message format:

```
YYYY-MM-DD HH:MM:SS [LEVEL] logger-name: message text
```

---

## Extension Points

| What you want to do | Where to change |
|---------------------|----------------|
| Add a new automation task | Create `scripts/my_task.py` with a `run()` function. |
| Expose the task via the automation CLI | Add an entry to `configs/tools_registry.yaml`. |
| Add new environment variables | Add placeholder entries to `.env.example`; use `require_env()` in the script. |
| Schedule a task with cron | Add a line to `configs/crontab.example`; run `cron_installer.py install`. |
| Change log retention | Configure `scripts/log_rotation.py` via environment variables. |
| Add a new credential type | Document it in `.env.example` and `docs/credentials.md`. |

For a practical walkthrough of adding a new tool, see
[adding_tools.md](adding_tools.md).
