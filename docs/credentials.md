# Credential Configuration Guide

This document explains how to configure credentials and sensitive values for
the **home-automation-scripts** project and how the setup prevents secrets from
ever reaching the Git repository.

---

## Overview

All secrets are kept **outside version control** by storing them in a local
`.env` file (or in the `secrets/` directory) that is permanently listed in
`.gitignore`.  A safe, placeholder-only `.env.example` file is committed so
that every contributor knows which variables to set.

```
home-automation-scripts/
├── .env.example   ← committed – placeholder values only, no real secrets
├── .env           ← NOT committed – your local secrets (gitignored)
└── secrets/       ← NOT committed – local credential files (gitignored)
```

---

## Quick Start

### 1 – Copy the example template

```bash
cp .env.example .env
```

### 2 – Fill in your real values

Open `.env` in your preferred editor and replace every placeholder (e.g.
`your_mqtt_password`) with the actual credential:

```bash
nano .env        # or: vim .env, code .env, …
```

### 3 – Verify that `.env` is gitignored

```bash
git status       # .env must NOT appear in the output
git check-ignore -v .env   # should print: .gitignore:5:.env
```

If `.env` ever appears in `git status` as an untracked or modified file,
**stop immediately** and do not commit until you have confirmed that `.gitignore`
is protecting it.

---

## Environment Variables Reference

The following variables are defined in `.env.example`.  Copy the file and fill
in every section that applies to your setup.

| Variable | Description | Required |
|----------|-------------|----------|
| `MQTT_HOST` | Hostname or IP of the MQTT broker | Yes if using MQTT |
| `MQTT_PORT` | Port of the MQTT broker (default 1883) | Yes if using MQTT |
| `MQTT_USERNAME` | MQTT broker username | Yes if broker requires auth |
| `MQTT_PASSWORD` | MQTT broker password | Yes if broker requires auth |
| `HA_URL` | Base URL of your Home Assistant instance | Yes if using HA |
| `HA_TOKEN` | Home Assistant long-lived access token | Yes if using HA |
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token | Yes if using Telegram notifications |
| `TELEGRAM_CHAT_ID` | Telegram chat/group ID | Yes if using Telegram notifications |
| `PUSHBULLET_API_KEY` | Pushbullet API key | Optional |
| `DB_HOST` | Database server hostname | Yes if using a DB |
| `DB_PORT` | Database server port | Yes if using a DB |
| `DB_NAME` | Database name | Yes if using a DB |
| `DB_USER` | Database username | Yes if using a DB |
| `DB_PASSWORD` | Database password | Yes if using a DB |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key | Yes if using weather scripts |

---

## Loading Credentials in Scripts

### Python scripts

Use the `tools/env_loader.py` utility to load and validate credentials at the
start of any Python script:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools.env_loader import require_env

# Load the .env file and assert that these variables are present.
env = require_env(["MQTT_HOST", "MQTT_USERNAME", "MQTT_PASSWORD"])

mqtt_host = env["MQTT_HOST"]
```

If any listed variable is missing or empty, `require_env` raises a
`RuntimeError` with a clear message telling you which variables need to be set.

### Shell scripts

Source the `.env` file at the top of any shell script:

```bash
# Load .env from the repository root (adjust the path if needed)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # export each KEY=VALUE line, ignoring comments and blank lines
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

# Now the variables are available:
echo "Connecting to ${MQTT_HOST}…"
```

### Validating variables from the command line

```bash
python3 tools/env_loader.py MQTT_HOST MQTT_PASSWORD HA_TOKEN
```

Exits with code `0` if all variables are set, `1` otherwise.  Each set
variable is reported as `****` (never the real value).

---

## The `secrets/` Directory

For credential files that are not plain key–value pairs (certificates, SSH
keys, JSON service-account files, etc.) use the `secrets/` directory.

- Created automatically by `install.sh`.
- Permissions are set to **700** (owner read/write/execute only) so other
  local users on the same machine cannot read the files.
- The entire directory is permanently gitignored.

```bash
# Example: place a Home Assistant certificate bundle here
cp ~/Downloads/ha-cert.pem secrets/ha-cert.pem
chmod 600 secrets/ha-cert.pem
```

---

## Preventing Accidental Secret Leakage

The `.gitignore` at the repository root permanently excludes:

| Pattern | What it protects |
|---------|-----------------|
| `secrets/` | The entire secrets directory |
| `.env` | Your filled-in environment file |
| `.env.*` | Any environment variant (e.g. `.env.prod`) |
| `!.env.example` | Explicitly keeps the placeholder template committed |
| `*.key`, `*.pem`, `*.p12`, `*.pfx` | Private keys and certificates |
| `id_rsa`, `id_ed25519` | SSH private keys |
| `*.secret` | Catch-all for other secret files |

### Pre-commit hygiene checklist

Before every `git commit`, verify:

- [ ] `git diff --cached` contains no passwords, tokens, or API keys.
- [ ] No new file in `secrets/` is staged: `git status secrets/` should be
  empty.
- [ ] `.env` is **not** staged.

### Optional: pre-commit hook

To add an automated guard, install [detect-secrets](https://github.com/Yelp/detect-secrets):

```bash
pip install detect-secrets
detect-secrets scan > .secrets.baseline
```

Then add a pre-commit hook (`.git/hooks/pre-commit`):

```bash
#!/usr/bin/env bash
detect-secrets-hook --baseline .secrets.baseline
```

---

## Rotating Credentials

1. Update the value in your local `.env` (or the relevant file in `secrets/`).
2. Revoke / regenerate the old secret in the issuing service.
3. Test the affected scripts.
4. Never commit the new secret – it stays in `.env` just like the old one.
