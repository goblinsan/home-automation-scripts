# home-automation-scripts

A curated collection of scripts, configurations, and tools for automating and managing a home lab or smart-home environment.

---

## Purpose

The goal of this project is to centralise all home-automation logic in one version-controlled place so that it is easy to:

- Reproduce a setup on a new machine in minutes.
- Review and audit every change through pull requests.
- Keep secrets and sensitive data *completely* out of the repository.

---

## Philosophy

| Principle | What it means in practice |
|-----------|--------------------------|
| **Simple over clever** | Prefer readable shell/Python over complex frameworks. |
| **Secrets stay secret** | Credentials and tokens live outside the repo (env files, a secrets manager, or a `secrets/` folder that is always gitignored). |
| **Idempotent by default** | Running a script twice should produce the same result as running it once. |
| **Document everything** | Every script and config gets a short comment block explaining what it does and why. |

---

## Directory Structure

```
home-automation-scripts/
├── scripts/      # Automation and maintenance scripts
├── configs/      # Configuration templates and non-secret settings
├── tools/        # Helper utilities and development tooling
├── docs/         # Additional documentation and runbooks
├── secrets/      # Local secrets – NEVER committed (gitignored)
└── logs/         # Runtime logs – NEVER committed (gitignored)
```

### `scripts/`
Shell, Python, or other executable scripts that perform automation tasks (backups, service restarts, notifications, etc.).

### `configs/`
Non-secret configuration files and templates. Files that require secrets should be provided as `.example` templates; the real filled-in copies go in `secrets/`.

### `tools/`
Development and operational utilities: linting helpers, deployment wrappers, one-off maintenance scripts that support the project itself.

### `docs/`
Runbooks, architecture notes, and any additional documentation that does not belong in a script comment block.

| Document | Description |
|----------|-------------|
| [docs/usage.md](docs/usage.md) | How to run automation tasks manually |
| [docs/adding_tools.md](docs/adding_tools.md) | Step-by-step guide for adding new tools |
| [docs/architecture.md](docs/architecture.md) | How scripts, registry, cron, and secrets interact |
| [docs/installation.md](docs/installation.md) | Full installation walkthrough |
| [docs/cron_jobs.md](docs/cron_jobs.md) | Cron scheduling and systemd timer guide |
| [docs/credentials.md](docs/credentials.md) | Credential and secrets configuration |

### `secrets/` *(local only)*
Filled-in config files, API keys, tokens, and any other sensitive material. This directory is permanently gitignored.

### `logs/` *(local only)*
Runtime output from scripts. Also permanently gitignored.

---

## Quick Start

### Prerequisites

- Git
- Bash 4+
- A supported Linux distro (Debian/Ubuntu, Fedora/RHEL, or Arch Linux)

### 1 – Clone the repository

```bash
git clone https://github.com/goblinsan/home-automation-scripts.git
cd home-automation-scripts
```

### 2 – Run the bootstrap installer

```bash
bash install.sh
```

This installs all system dependencies, creates the `secrets/` and `logs/` directories, sets up a Python virtual environment at `.venv/`, and installs Python packages from `requirements.txt`.

> Run `bash install.sh --dry-run` to preview the steps without making any changes.

### 3 – Configure your secrets

```bash
# Copy any .example config templates from configs/ to secrets/ and fill them in:
cp configs/*.example secrets/   # run only if templates exist
```

### 4 – Run a script

```bash
source .venv/bin/activate
bash scripts/<script-name>.sh
```

Each script includes a usage comment at the top. Run `bash scripts/<script-name>.sh --help` (where supported) for options.

### 5 – Use the automation runner (Python tasks)

The central runner discovers Python scripts in `scripts/` that expose a `run()` function and executes them with consistent logging and error handling.

```bash
source .venv/bin/activate

# List all available tasks
python3 tools/runner.py list

# Run one or more tasks
python3 tools/runner.py run <task-name>
python3 tools/runner.py run <task1> <task2>
```

**Writing a new task** — create `scripts/my_task.py`:

```python
DESCRIPTION = "Short description shown in the task list."

def run():
    # automation logic here
    print("Task executed!")
```

Each run produces a timestamped log file in `logs/` (e.g. `logs/runner_20260101_120000.log`). Failures are captured with full tracebacks and logged clearly; the runner exits with code `1` if any task fails.

For a full step-by-step guide, including cron scheduling and troubleshooting, see [docs/installation.md](docs/installation.md).

For the complete usage guide (all CLI options, log reading, and troubleshooting), see [docs/usage.md](docs/usage.md).

### 6 – Schedule tasks with cron

A cron job template (`configs/crontab.example`) and a helper installer are included. To install predefined scheduled tasks:

```bash
source .venv/bin/activate

# Preview what will be installed
python3 tools/cron_installer.py list

# Dry-run to confirm the crontab changes
python3 tools/cron_installer.py install --dry-run

# Install the cron jobs
python3 tools/cron_installer.py install

# Remove the managed entries at any time
python3 tools/cron_installer.py uninstall
```

See [docs/cron_jobs.md](docs/cron_jobs.md) for the full scheduling guide, including manual crontab editing, safety guidelines, and systemd timer instructions.

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/usage.md](docs/usage.md) | How to run automation tasks manually |
| [docs/adding_tools.md](docs/adding_tools.md) | Step-by-step guide for adding new tools |
| [docs/architecture.md](docs/architecture.md) | How scripts, registry, cron, and secrets interact |
| [docs/installation.md](docs/installation.md) | Full installation walkthrough |
| [docs/cron_jobs.md](docs/cron_jobs.md) | Cron scheduling and systemd timer guide |
| [docs/credentials.md](docs/credentials.md) | Credential and secrets configuration |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Keep commits small and focused.
3. Never commit secrets, logs, or generated output.
4. Open a pull request with a clear description of what the change does and why.

---

## License

See [LICENSE](LICENSE) for details.
