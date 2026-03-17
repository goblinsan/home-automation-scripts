# Strava Sync

Automatically fetches recent [Strava](https://www.strava.com/) activities once
per day and stores them locally in a normalized JSON format.

---

## Table of Contents

1. [Required Environment Variables](#required-environment-variables)
2. [How to Run Manually](#how-to-run-manually)
3. [How to Install the Cron Job](#how-to-install-the-cron-job)
4. [Output Files](#output-files)
5. [Obtaining a Strava Refresh Token](#obtaining-a-strava-refresh-token)

---

## Required Environment Variables

Add the following entries to your local `.env` file (copy from `.env.example`
if you haven't already):

| Variable | Required | Description |
|---|---|---|
| `STRAVA_CLIENT_ID` | Yes | Numeric client ID from your Strava API application. |
| `STRAVA_CLIENT_SECRET` | Yes | Client secret from your Strava API application. |
| `STRAVA_REFRESH_TOKEN` | Yes | Long-lived refresh token (see [Obtaining a Strava Refresh Token](#obtaining-a-strava-refresh-token)). |
| `STRAVA_LOOKBACK_DAYS` | No | Number of days of activities to fetch (default: `1`). |
| `STRAVA_OUTPUT_DIR` | No | Output directory for JSON files (default: `data/strava/activities/`). |
| `STRAVA_MAX_RETRIES` | No | Retry count on transient API errors (default: `3`). |

Verify that the required variables are set before scheduling the job:

```bash
python3 tools/env_loader.py STRAVA_CLIENT_ID STRAVA_CLIENT_SECRET STRAVA_REFRESH_TOKEN
```

---

## How to Run Manually

### Via the automation CLI (recommended)

```bash
source .venv/bin/activate
python3 tools/automation.py run strava-sync
```

### Via the task runner

```bash
source .venv/bin/activate
python3 tools/runner.py run strava_sync
```

### Direct invocation

```bash
source .venv/bin/activate
python3 scripts/strava_sync.py
```

### Via the bash wrapper

```bash
./run_strava_sync.sh
```

The wrapper activates the virtual environment, loads `.env`, and runs the
Python script.  It exits non-zero on failure, making it safe to call from cron.

### Review the log output

```bash
ls -t logs/ | head -5
cat logs/strava-sync_<timestamp>.log
```

---

## How to Install the Cron Job

### Option A – cron_installer helper (recommended)

The `cron_installer` tool reads `configs/crontab.example`, substitutes
`$REPO_ROOT` and `$PYTHON` with the correct absolute paths for your machine,
and writes a managed block to your user crontab.

```bash
source .venv/bin/activate

# Preview the entries that would be added:
python3 tools/cron_installer.py install --dry-run

# Install the managed block:
python3 tools/cron_installer.py install

# Verify:
python3 tools/cron_installer.py list
```

### Option B – manual crontab entry

Open your crontab with `crontab -e` and add:

```cron
# Strava activity sync – runs daily at 06:00
0 6 * * * /usr/bin/env bash -c 'cd /path/to/repo && ./run_strava_sync.sh >> /path/to/repo/logs/strava.log 2>&1'
```

Replace `/path/to/repo` with the absolute path to your cloned repository.

### Cron environment tips

- Cron runs with a minimal `PATH`.  Always use absolute paths (the bash wrapper
  handles this automatically).
- Redirect stdout and stderr to a log file so failures remain visible:
  `>> logs/strava.log 2>&1`
- Avoid embedding secrets in cron entries; use `.env` instead.
- Add `MAILTO=""` at the top of your crontab to suppress email on each run.

---

## Output Files

All output is written to `data/strava/activities/` (or `STRAVA_OUTPUT_DIR` if
set).  These files are gitignored to prevent personal activity data from
being committed.

| File | Description |
|---|---|
| `latest.json` | Most recent snapshot; overwritten on each run (written atomically). |
| `activities_YYYYMMDD_HHMMSS.json` | Timestamped archive; one file per run. |

### JSON structure

```json
{
  "fetched_at": "2026-01-02T06:00:01+00:00",
  "activity_count": 3,
  "activities": [
    {
      "id": 12345678,
      "name": "Morning Run",
      "type": "Run",
      "sport_type": "Run",
      "start_date": "2026-01-02T05:30:00Z",
      "start_date_local": "2026-01-02T06:30:00Z",
      "distance_m": 8045.2,
      "moving_time_s": 2580,
      "elapsed_time_s": 2640,
      "elevation_gain_m": 45.0,
      "average_speed_mps": 3.12,
      "max_speed_mps": 4.5,
      "average_heartrate": 148.0,
      "max_heartrate": 172.0,
      "calories": 520,
      "kudos_count": 4,
      "achievement_count": 1,
      "map_summary_polyline": "..."
    }
  ]
}
```

No tokens or secrets are ever written to the output files.

---

## Obtaining a Strava Refresh Token

1. Go to [https://www.strava.com/settings/api](https://www.strava.com/settings/api)
   and create (or view) your API application.  Note the **Client ID** and
   **Client Secret**.

2. Construct the authorization URL (replace `YOUR_CLIENT_ID`):

   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
   ```

3. Open the URL in your browser, authorize the app, and copy the `code`
   parameter from the redirect URL (e.g. `http://localhost/?code=abc123…`).

4. Exchange the code for tokens with a one-time `curl` call:

   ```bash
   curl -X POST https://www.strava.com/oauth/token \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=YOUR_AUTHORIZATION_CODE \
     -d grant_type=authorization_code
   ```

5. Copy the `refresh_token` from the JSON response and set it as
   `STRAVA_REFRESH_TOKEN` in your `.env` file.

The sync script automatically exchanges this refresh token for a fresh access
token before every API call, so you only need to perform the authorization flow
once.
