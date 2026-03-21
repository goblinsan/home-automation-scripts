# Installation Guide

This guide walks you through setting up the **home-automation-scripts** suite on a fresh Linux home server from scratch.

---

## System Requirements

| Requirement | Minimum version | Notes |
|-------------|----------------|-------|
| Operating system | Debian 11 / Ubuntu 22.04 or equivalent | Other distros work; see [Package manager support](#package-manager-support) |
| CPU / RAM | 1 vCPU / 512 MB | More is recommended if the gateway app runs on the same host |
| Disk | 1 GB free | More is recommended once Docker images are stored locally |
| Git | 2.x | `git --version` |
| Python | 3.9+ | `python3 --version` |
| Bash | 4+ | `bash --version` |

---

## System Dependencies

The following packages must be present on the host. `install.sh` handles this automatically (see next section).

| Package | Purpose |
|---------|---------|
| `git` | Clone and update the repository |
| `python3` | Run Python automation scripts |
| `python3-pip` | Install Python packages |
| `python3-venv` | Create isolated virtual environments |
| `cron` / `cronie` | Schedule recurring scripts |
| `jq` | Parse JSON in shell scripts |
| `curl` | Make HTTP requests from shell scripts |
| `wget` | Download files from shell scripts |

Gateway deployment also requires:

| Package | Purpose |
|---------|---------|
| Docker Engine | Runs the blue and green gateway slots |
| nginx | Stable ingress and traffic switching |
| systemd | Supervises the slot services |

### Package manager support

| Distro family | Package manager | Supported by `install.sh` |
|---------------|----------------|--------------------------|
| Debian / Ubuntu | `apt` | ✅ |
| Fedora / RHEL / CentOS | `dnf` / `yum` | ✅ |
| Arch Linux | `pacman` | ✅ |
| Other | — | Manual installation required |

---

## Python Virtual Environment

All Python scripts in this project run inside a dedicated virtual environment located at `.venv/` in the repository root. This keeps dependencies isolated from the system Python installation and makes the project reproducible.

`install.sh` creates the virtual environment and installs the packages listed in `requirements.txt` automatically.

To activate the environment manually:

```bash
source .venv/bin/activate
```

To deactivate:

```bash
deactivate
```

---

## Step-by-Step Installation

### 1 – Update the system

```bash
sudo apt-get update && sudo apt-get upgrade -y   # Debian/Ubuntu
# or
sudo dnf upgrade -y                               # Fedora/RHEL
```

### 2 – Install Git (if not already installed)

```bash
sudo apt-get install -y git   # Debian/Ubuntu
```

### 3 – Clone the repository

```bash
git clone https://github.com/goblinsan/home-automation-scripts.git
cd home-automation-scripts
```

### 4 – Run the bootstrap installer

```bash
bash install.sh
```

The installer will:

1. Install all required system packages listed above.
2. Create the `secrets/` and `logs/` directories.
3. Create the Python virtual environment at `.venv/`.
4. Install all Python packages from `requirements.txt`.

> **Tip:** Run `bash install.sh --dry-run` first to see what the script would do without making any changes.

### 5 – Configure your secrets

Copy the example configuration templates from `configs/` to `secrets/` and fill them in with your real credentials:

```bash
cp configs/*.example secrets/   # copy all templates (if any exist)
# Edit each file in secrets/ with your actual values
```

> **Important:** The `secrets/` directory is permanently gitignored. Never move credentials into any other tracked location.

### 6 – Verify the environment

```bash
source .venv/bin/activate
python3 --version          # should show 3.9 or later
pip list                   # should show the installed packages
deactivate
```

### 7 – (Optional) Configure the gateway runtime

If this machine is also the gateway host, complete the Docker/nginx setup
described in [docs/blue_green.md](blue_green.md). `install.sh` does not
install or configure Docker or nginx for you.

If you also want source-controlled scheduled tasks on the gateway host:

```bash
sudo cp ops/systemd/automation.env.example /etc/home-automation/automation.env
bash deploy/install_scheduled_jobs.sh
```

### 8 – (Optional) Schedule scripts with cron

A ready-to-use template and a helper installer are included.  Run the
installer to preview and apply the predefined cron jobs:

```bash
source .venv/bin/activate

# Preview entries (no changes made)
python3 tools/cron_installer.py list

# Dry-run to confirm the resulting crontab
python3 tools/cron_installer.py install --dry-run

# Apply the cron jobs
python3 tools/cron_installer.py install
```

To remove the managed entries later:

```bash
python3 tools/cron_installer.py uninstall
```

For advanced options (custom template paths, manual crontab editing, and
systemd timer instructions) see [docs/cron_jobs.md](cron_jobs.md).

---

## Post-install Checklist

- [ ] `install.sh` completed without errors
- [ ] `secrets/` directory created and populated
- [ ] Python virtual environment activates successfully
- [ ] All required scripts run without errors
- [ ] Cron jobs scheduled (if applicable)

---

## Troubleshooting

### `python3-venv` not found on Ubuntu

On some minimal Ubuntu images the `venv` module ships as a separate package:

```bash
sudo apt-get install -y python3-venv
```

### `Permission denied` when running install.sh

Ensure the script is executable or invoke it explicitly with `bash`:

```bash
bash install.sh
```

### Virtual environment not activating

Make sure you are sourcing the script, not executing it:

```bash
source .venv/bin/activate   # correct
.venv/bin/activate          # incorrect – runs in a subshell
```

### Package installation fails behind a proxy

Export proxy variables before running `install.sh`:

```bash
export http_proxy=http://proxy.example.com:3128
export https_proxy=http://proxy.example.com:3128
bash install.sh
```

---

## Updating

To pull the latest changes and refresh Python packages:

```bash
git pull
source .venv/bin/activate
pip install -r requirements.txt --upgrade
deactivate
```
