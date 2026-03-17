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

### `secrets/` *(local only)*
Filled-in config files, API keys, tokens, and any other sensitive material. This directory is permanently gitignored.

### `logs/` *(local only)*
Runtime output from scripts. Also permanently gitignored.

---

## Quick Start

### Prerequisites

- Git
- Bash 4+ (macOS users: `brew install bash`)
- Python 3.9+ (optional, required only for Python scripts)

### 1 – Clone the repository

```bash
git clone https://github.com/goblinsan/home-automation-scripts.git
cd home-automation-scripts
```

### 2 – Set up your secrets directory

```bash
mkdir -p secrets logs
# Copy any .example config templates from configs/ to secrets/ and fill them in:
# cp configs/my-service.conf.example secrets/my-service.conf
```

### 3 – Run a script

```bash
bash scripts/<script-name>.sh
```

Each script includes a usage comment at the top. Run `bash scripts/<script-name>.sh --help` (where supported) for options.

---

## Contributing

1. Fork the repository and create a feature branch.
2. Keep commits small and focused.
3. Never commit secrets, logs, or generated output.
4. Open a pull request with a clear description of what the change does and why.

---

## License

See [LICENSE](LICENSE) for details.
