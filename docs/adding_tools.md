# Adding New Automation Tools

This guide provides step-by-step instructions for creating a new automation
tool and registering it with the **home-automation-scripts** system.

For an overview of how the components fit together, see
[architecture.md](architecture.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Step 1 – Create the Script](#step-1--create-the-script)
3. [Step 2 – Register the Tool](#step-2--register-the-tool)
4. [Step 3 – Add Required Credentials](#step-3--add-required-credentials)
5. [Step 4 – Test Manually](#step-4--test-manually)
6. [Step 5 – Schedule with Cron (Optional)](#step-5--schedule-with-cron-optional)
7. [Script Template Reference](#script-template-reference)
8. [Registry Field Reference](#registry-field-reference)
9. [Best Practices](#best-practices)

---

## Overview

Each automation tool is a Python script placed in the `scripts/` directory.
To make a script available via the `automation` CLI it must be registered in
`configs/tools_registry.yaml`.

The minimum requirements for a tool script are:

- Located in `scripts/`.
- Exposes a module-level `run()` callable.
- Optionally defines a `DESCRIPTION` string for use in the task listing.

---

## Step 1 – Create the Script

Create a new Python file in `scripts/`.  Use lowercase letters and underscores
for the filename (e.g. `scripts/my_tool.py`).

### Minimal template

```python
#!/usr/bin/env python3
"""
scripts/my_tool.py – Short one-line description of what this tool does.

Usage (via automation CLI):
    python3 tools/automation.py run my-tool

Usage (direct):
    python3 scripts/my_tool.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure repo root is on sys.path so that ``tools.*`` imports work.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.logger import get_logger  # noqa: E402

DESCRIPTION = "Short description shown in the task list."


def run() -> None:
    """Entry point called by the automation runner."""
    log = get_logger("my-tool")
    log.info("my-tool started")

    # --- Your automation logic here ---

    log.info("my-tool finished")


if __name__ == "__main__":
    run()
```

### Using environment variables

If the tool needs credentials or configuration from `.env`, import
`require_env` to load and validate them at startup:

```python
from tools.env_loader import require_env  # noqa: E402

_REQUIRED_ENV_VARS = ("MY_API_KEY", "MY_HOST")


def run() -> None:
    log = get_logger("my-tool")

    try:
        env = require_env(_REQUIRED_ENV_VARS)
    except RuntimeError as exc:
        log.error("Missing environment variables: %s", exc)
        raise

    api_key = env["MY_API_KEY"]
    host = env["MY_HOST"]

    # Use api_key and host …
```

Add the corresponding placeholder entries to `.env.example` so that other
contributors know which variables to set:

```bash
# .env.example
# My Tool
MY_API_KEY=your_api_key_here
MY_HOST=service.example.local
```

---

## Step 2 – Register the Tool

Open `configs/tools_registry.yaml` and add an entry under the `tools` list:

```yaml
tools:
  # … existing entries …

  - name: my-tool
    description: "Short description shown in the task list."
    script: scripts/my_tool.py
    enabled: true
```

### Field descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier used in CLI commands. Use lowercase letters and hyphens (e.g. `my-tool`). |
| `description` | No | Human-readable description shown by `automation list`. Defaults to `(no description)`. |
| `script` | Yes | Path to the Python script, relative to the repository root. |
| `enabled` | No | Set to `false` to disable the tool without removing the entry. Defaults to `true`. |

### Validate the registry

After editing, confirm the registry parses correctly:

```bash
source .venv/bin/activate
python3 tools/registry.py
```

The output should include your new tool:

```
Name                     Enabled  Script
------------------------------------------------------------
my-tool                  yes      scripts/my_tool.py
```

---

## Step 3 – Add Required Credentials

If the tool reads environment variables, document the new variables in
`.env.example` (placeholder values only — never real secrets):

```bash
# .env.example — add a new section for your tool
# -----------------------------------------------------------------------------
# My Tool
# -----------------------------------------------------------------------------
MY_API_KEY=your_api_key_here
MY_HOST=service.example.local
```

Then add the real values to your local `.env` (which is gitignored):

```bash
nano .env
```

Verify that the variables are set before running the tool:

```bash
python3 tools/env_loader.py MY_API_KEY MY_HOST
```

---

## Step 4 – Test Manually

### Run via the automation CLI

```bash
source .venv/bin/activate
python3 tools/automation.py list           # confirm the tool appears
python3 tools/automation.py run my-tool   # run the tool
```

### Run via the runner CLI

```bash
python3 tools/runner.py list              # confirm the task appears
python3 tools/runner.py run my_tool       # note: uses the filename stem
```

### Run directly

```bash
python3 scripts/my_tool.py
```

### Review the log output

```bash
ls -t logs/ | head -3
cat logs/<latest-file>.log
```

---

## Step 5 – Schedule with Cron (Optional)

To run the tool on a recurring schedule, add an entry to
`configs/crontab.example`:

```cron
# Run my-tool every day at 04:00.
0 4 * * * $PYTHON $REPO_ROOT/tools/automation.py run my-tool >> $REPO_ROOT/logs/cron.log 2>&1
```

Then reinstall the managed cron block:

```bash
source .venv/bin/activate
python3 tools/cron_installer.py install --dry-run   # preview first
python3 tools/cron_installer.py install
```

See [cron_jobs.md](cron_jobs.md) for the full scheduling guide.

---

## Script Template Reference

Below is a complete annotated template covering all common patterns:

```python
#!/usr/bin/env python3
"""
scripts/my_tool.py – One-line summary of the tool's purpose.

Usage (via automation CLI):
    python3 tools/automation.py run my-tool

Usage (direct):
    python3 scripts/my_tool.py

Environment variables required:
    MY_API_KEY   API key for the external service.
    MY_HOST      Hostname of the external service.

Environment variables optional:
    MY_TIMEOUT   Request timeout in seconds (default: 30).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.env_loader import require_env  # noqa: E402
from tools.logger import get_logger       # noqa: E402

# Shown by ``automation list`` and ``runner list``.
DESCRIPTION = "One-line description of what this tool does."

_REQUIRED_VARS = ("MY_API_KEY", "MY_HOST")
_DEFAULT_TIMEOUT = 30


def _do_work(api_key: str, host: str, timeout: int) -> None:
    """Core logic, separate from the entry-point for testability."""
    log = get_logger("my-tool")
    log.info("Connecting to %s …", host)
    # … implementation …
    log.info("Done.")


def run() -> None:
    """Entry point called by the automation runner or invoked directly."""
    log = get_logger("my-tool")

    try:
        env = require_env(_REQUIRED_VARS)
    except RuntimeError as exc:
        log.error("Missing environment variables: %s", exc)
        raise

    timeout = int(os.environ.get("MY_TIMEOUT", _DEFAULT_TIMEOUT))

    _do_work(
        api_key=env["MY_API_KEY"],
        host=env["MY_HOST"],
        timeout=timeout,
    )


if __name__ == "__main__":
    run()
```

---

## Registry Field Reference

Full schema for an entry in `configs/tools_registry.yaml`:

```yaml
- name: my-tool           # (required) unique CLI identifier
  description: "…"        # (optional) shown in `automation list`
  script: scripts/my_tool.py  # (required) path relative to repo root
  enabled: true           # (optional) set false to disable without deleting
```

---

## Best Practices

### Keep `run()` free of side effects at import time

The runner imports every script in `scripts/` to discover tasks.  Any
top-level code that makes network calls, reads files, or raises exceptions
will break discovery for *all* tasks.  Move all side-effectful logic inside
`run()` or helper functions called by it.

### Always use the logger

Avoid bare `print()` calls.  Use `get_logger` so output is automatically
written to both the terminal and a timestamped log file:

```python
log = get_logger("my-tool")
log.info("Task started")
log.warning("Low disk space: %s%%", pct)
log.error("Connection failed: %s", exc)
```

### Raise on unrecoverable errors

If the tool cannot proceed (e.g. a required API key is missing), raise an
exception rather than silently returning.  The runner catches all exceptions,
logs the traceback, and sets the exit code to `1` so failures are visible.

### Test before scheduling

Always run the tool at least once manually before adding it to the crontab:

```bash
python3 tools/automation.py run my-tool
```

### Keep scripts idempotent

Running a script twice should produce the same end result as running it once
— write state with checks, use upserts instead of inserts, and avoid
appending duplicates to files.

### Never hard-code secrets

All credentials must come from environment variables loaded via
`tools/env_loader.py`.  Never embed tokens, passwords, or API keys in the
script source code.
