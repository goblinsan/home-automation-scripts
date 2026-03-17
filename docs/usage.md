# Usage Guide

This guide explains how to run home-automation tasks manually, either through
the automation CLI, the runner, or by invoking scripts directly.

For installation, see [installation.md](installation.md).  
For scheduling recurring tasks, see [cron_jobs.md](cron_jobs.md).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Activating the Virtual Environment](#activating-the-virtual-environment)
3. [Automation CLI (`tools/automation.py`)](#automation-cli)
4. [Runner CLI (`tools/runner.py`)](#runner-cli)
5. [Running Scripts Directly](#running-scripts-directly)
6. [Validating Environment Variables](#validating-environment-variables)
7. [Reading Logs](#reading-logs)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before running any task, ensure you have completed the installation steps:

```bash
# From the repository root
bash install.sh
cp .env.example .env
# Fill in .env with your real credentials
```

See [installation.md](installation.md) for the full setup guide and
[credentials.md](credentials.md) for credential configuration.

---

## Activating the Virtual Environment

All Python tools must be run with the project virtual environment active.
Activate it once per shell session:

```bash
source .venv/bin/activate
```

When active, the shell prompt changes to show `(.venv)`.  To deactivate:

```bash
deactivate
```

---

## Automation CLI

`tools/automation.py` is the primary interface for running **registered tools**
— tools listed in `configs/tools_registry.yaml`.

### List available tools

```bash
python3 tools/automation.py list
```

Example output:

```
Tool                     Description
------------------------------------------------------------
github-helper            List open GitHub issues and project board items for a repository
health-check             Monitor disk usage, CPU load, and memory utilization
log-rotation             Automatically prune old log files
package-update-notifier  Notify when system package updates are available
```

### Run a single tool

```bash
python3 tools/automation.py run health-check
```

### Run multiple tools in sequence

```bash
python3 tools/automation.py run health-check log-rotation
```

Tools are executed in the order specified.  If one tool fails the subsequent
tools still run, and the CLI exits with code `1` to signal that at least one
tool failed.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All tools completed successfully (or `list` was used). |
| `1` | One or more tools failed or an unknown tool was requested. |

---

## Runner CLI

`tools/runner.py` discovers and runs **any** Python file in `scripts/` that
exposes a `run()` function, without requiring a registry entry.  It is useful
for running custom one-off scripts and for testing new scripts before
registering them.

### List available tasks

```bash
python3 tools/runner.py list
```

Example output:

```
Task                      Description
------------------------------------------------------------
github_helper             List open GitHub issues and project board items for a repository
health_check              Monitor disk usage, CPU load, and memory utilization
log_rotation              Automatically prune old log files
package_update_notifier   Notify when system package updates are available
```

> **Note:** The runner uses the Python file's *stem* as the task name
> (e.g. `health_check` for `scripts/health_check.py`), while the automation
> CLI uses the `name` field from the registry (e.g. `health-check`).

### Run a task

```bash
python3 tools/runner.py run health_check
```

### Run multiple tasks

```bash
python3 tools/runner.py run health_check log_rotation
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All tasks completed successfully (or `list` was used). |
| `1` | One or more tasks failed or an unknown task was requested. |

---

## Running Scripts Directly

Every script in `scripts/` can also be invoked directly without the runner or
automation CLI.  This is convenient when testing or debugging a single script.

```bash
python3 scripts/health_check.py
python3 scripts/github_helper.py
python3 scripts/log_rotation.py
python3 scripts/package_update_notifier.py
```

Direct invocation uses the same logging setup as the runner — output appears
both in the terminal and in a timestamped file under `logs/`.

---

## Validating Environment Variables

Before running scripts that require credentials, confirm all variables are
present using the `env_loader` CLI:

```bash
# Check that specific variables are set
python3 tools/env_loader.py MQTT_HOST HA_TOKEN GITHUB_TOKEN
```

Example output (real values are never printed):

```
  MQTT_HOST: ******** (set)
  HA_TOKEN:  ******** (set)
  GITHUB_TOKEN: ******** (set)
```

If a variable is missing, the tool prints a clear error and exits with code `1`:

```
ERROR: The following required environment variables are not set:
  GITHUB_TOKEN

Copy .env.example to .env and fill in the missing values.
```

You can also specify an explicit `.env` file path:

```bash
python3 tools/env_loader.py --env-file /path/to/custom.env GITHUB_TOKEN
```

---

## Reading Logs

Every run produces a timestamped log file in the `logs/` directory:

```
logs/runner_20260101_120000_000000.log
logs/health-check_20260101_120001_000000.log
```

To monitor a log file in real time:

```bash
tail -f logs/<filename>.log
```

To view the most recent log for any tool:

```bash
ls -t logs/ | head -5      # list the five most recent log files
cat logs/<filename>.log    # print the full log
```

Log lines follow the format:

```
YYYY-MM-DD HH:MM:SS [LEVEL] logger-name: message
```

---

## Troubleshooting

### `ModuleNotFoundError` for `tools.*`

The virtual environment must be active before running any Python tool:

```bash
source .venv/bin/activate
python3 tools/automation.py list
```

### `RuntimeError: The following required environment variables are not set`

Copy the example template and fill in the missing values:

```bash
cp .env.example .env
nano .env    # replace placeholder values with real credentials
```

### Task listed by `runner list` but not by `automation list`

The automation CLI only shows tools registered in `configs/tools_registry.yaml`.
Add the tool entry to the registry to make it available via the automation CLI.
See [adding_tools.md](adding_tools.md) for instructions.

### Script exits immediately with no output

Check the log file in `logs/` for the full error trace:

```bash
ls -t logs/ | head -3
cat logs/<latest-file>.log
```
