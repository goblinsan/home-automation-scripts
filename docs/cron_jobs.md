# Cron Job Scheduling Guide

This guide explains how to schedule **home-automation-scripts** tasks using cron
and provides instructions for the `tools/cron_installer.py` helper utility.

For an alternative based on systemd, see [Systemd Timer Alternative](#systemd-timer-alternative).

If this repo is being used as the gateway host control plane, prefer the
source-controlled timer units in `ops/systemd/timers/` together with
`deploy/install_scheduled_jobs.sh`.

---

## Table of Contents

1. [Overview](#overview)
2. [Cron Syntax Reference](#cron-syntax-reference)
3. [Quick Start with the Installer](#quick-start-with-the-installer)
4. [Manual Crontab Editing](#manual-crontab-editing)
5. [Template Variables](#template-variables)
6. [Safety Guidelines](#safety-guidelines)
7. [Systemd Timer Alternative](#systemd-timer-alternative)
8. [Troubleshooting](#troubleshooting)

---

## Overview

Cron is the standard Unix scheduler for recurring tasks.  Each entry in a
*crontab* (cron table) specifies when and how to run a command.  This project
ships a ready-to-use template at `configs/crontab.example` and a helper tool
at `tools/cron_installer.py` that installs or removes those entries
idempotently.

---

## Cron Syntax Reference

```
┌─────────── minute         (0–59)
│ ┌───────── hour           (0–23)
│ │ ┌─────── day of month   (1–31)
│ │ │ ┌───── month          (1–12)
│ │ │ │ ┌─── day of week    (0–7, 0 and 7 are both Sunday)
│ │ │ │ │
* * * * *  command to run
```

### Common schedule patterns

| Expression | Meaning |
|-----------|---------|
| `0 2 * * *` | Every day at 02:00 |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour on the hour |
| `0 0 * * 0` | Every Sunday at midnight |
| `0 6 1 * *` | First day of every month at 06:00 |
| `@reboot` | Once at system startup |
| `@daily` | Once a day (equivalent to `0 0 * * *`) |
| `@weekly` | Once a week (equivalent to `0 0 * * 0`) |

---

## Quick Start with the Installer

The `tools/cron_installer.py` helper reads `configs/crontab.example`,
substitutes the `$REPO_ROOT` and `$PYTHON` variables, and manages a clearly
marked block inside the user's crontab.

### 1 – Preview what will be installed

```bash
source .venv/bin/activate
python3 tools/cron_installer.py list
```

### 2 – Install the cron jobs (dry-run first)

```bash
python3 tools/cron_installer.py install --dry-run
```

Review the output, then apply:

```bash
python3 tools/cron_installer.py install
```

### 3 – Verify the installation

```bash
crontab -l
```

You should see a managed block delimited by:

```
# BEGIN home-automation-scripts managed block
...
# END home-automation-scripts managed block
```

### 4 – Remove the managed jobs at any time

```bash
python3 tools/cron_installer.py uninstall
```

### Installer options

| Option | Description |
|--------|-------------|
| `--dry-run` | Print changes without modifying the crontab. |
| `--repo-root PATH` | Override the repository root (default: auto-detected). |
| `--template PATH` | Use a different template file (default: `configs/crontab.example`). |

---

## Manual Crontab Editing

If you prefer to manage your crontab directly:

### 1 – Determine the absolute paths

```bash
# Repository root
pwd   # run from inside the cloned directory

# Python interpreter (venv)
which python3   # after activating .venv
```

### 2 – Open the crontab editor

```bash
crontab -e
```

### 3 – Add an entry

Replace `/path/to/home-automation-scripts` and `/path/to/python3` with the
values from the previous step:

```cron
# Run the backup task every day at 02:00
0 2 * * * /path/to/.venv/bin/python3 /path/to/home-automation-scripts/tools/runner.py run backup >> /path/to/home-automation-scripts/logs/cron.log 2>&1
```

### 4 – Verify the entry

```bash
crontab -l
```

---

## Template Variables

The `configs/crontab.example` template uses two placeholder variables that the
installer substitutes at install time:

| Variable | Replaced with |
|----------|--------------|
| `$REPO_ROOT` | Absolute path to the repository root (e.g. `/home/user/home-automation-scripts`) |
| `$PYTHON` | Path to the virtual-environment Python interpreter (`.venv/bin/python3`) or the system `python3` if no venv is present |

When editing the template manually, replace these variables with the actual
paths for your system.

---

## Safety Guidelines

### Always use absolute paths

Cron executes with a minimal `PATH` environment.  Using absolute paths avoids
*command not found* errors:

```cron
# Correct – absolute paths
0 2 * * * /home/user/home-automation-scripts/.venv/bin/python3 /home/user/home-automation-scripts/tools/runner.py run backup

# Incorrect – relies on PATH being set
0 2 * * * python3 tools/runner.py run backup
```

### Redirect output to a log file

Without redirection, cron mails stdout/stderr to the local user.  Always
redirect both streams to a log file:

```cron
0 2 * * * /path/to/python3 /path/to/runner.py run backup >> /path/to/logs/cron.log 2>&1
```

### Suppress unnecessary email

Add this line at the top of your crontab to disable cron's email feature:

```cron
MAILTO=""
```

### Never embed secrets in cron entries

Keep all credentials in `.env` (or `secrets/`).  The `tools/env_loader.py`
utility loads them at runtime, so cron entries themselves contain no sensitive
data.

### Test scripts before scheduling them

Run every script manually at least once before adding it to the crontab:

```bash
source .venv/bin/activate
python3 tools/runner.py run <task-name>
```

### Use `run-parts` or a wrapper for complex logic

For tasks that require environment setup, create a small wrapper script that
activates the virtual environment before invoking the runner:

```bash
#!/usr/bin/env bash
# scripts/cron_wrapper.sh
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${REPO_ROOT}/.venv/bin/activate"
exec python3 "${REPO_ROOT}/tools/runner.py" "$@"
```

Then reference the wrapper in your crontab:

```cron
0 2 * * * /path/to/home-automation-scripts/scripts/cron_wrapper.sh run backup >> /path/to/logs/cron.log 2>&1
```

---

## Systemd Timer Alternative

For systems running systemd (most modern Linux distros), *systemd timers*
offer richer scheduling features than cron, including dependency management,
journal logging, and automatic restart on failure.

### 1 – Create a service unit

Create `/etc/systemd/system/home-automation-backup.service` (or in
`~/.config/systemd/user/` for a user-level unit):

```ini
[Unit]
Description=Home Automation – backup task
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/home-automation-scripts
ExecStart=/path/to/.venv/bin/python3 /path/to/home-automation-scripts/tools/runner.py run backup
EnvironmentFile=/path/to/home-automation-scripts/.env
StandardOutput=journal
StandardError=journal
```

### 2 – Create a timer unit

Create `/etc/systemd/system/home-automation-backup.timer`:

```ini
[Unit]
Description=Run home-automation backup task daily at 02:00

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

### 3 – Enable and start the timer

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now home-automation-backup.timer
```

### 4 – Check the timer status

```bash
systemctl list-timers home-automation-backup.timer
journalctl -u home-automation-backup.service
```

---

## Troubleshooting

### Script does not run at the scheduled time

1. Confirm the crontab entry is saved: `crontab -l`
2. Check that the cron daemon is running: `systemctl status cron` (or `crond`)
3. Review the system mail or `/var/log/syslog` for cron errors
4. Test the exact command from the crontab entry by running it manually in a
   shell to confirm it works outside cron

### `python3: command not found` in cron

Cron runs with a minimal `PATH`.  Use the full absolute path to the Python
interpreter (e.g. `/home/user/home-automation-scripts/.venv/bin/python3`):

```bash
# Find the absolute path while the venv is active:
which python3
```

### Environment variables not available in cron

Cron does not source `.bashrc`, `.profile`, or `.bash_profile`.  Use
`tools/env_loader.py` (which reads `.env` directly) instead of relying on
exported shell variables.

### Log file not created

Ensure the `logs/` directory exists:

```bash
mkdir -p /path/to/home-automation-scripts/logs
```

The `install.sh` script creates this directory automatically.

### Cron entry works but the task fails silently

Ensure both stdout and stderr are redirected:

```cron
0 2 * * * /path/to/python3 /path/to/runner.py run backup >> /path/to/logs/cron.log 2>&1
#                                                                                    ^^^^ captures stderr too
```

Check the log file after the scheduled time:

```bash
tail -f /path/to/home-automation-scripts/logs/cron.log
```
