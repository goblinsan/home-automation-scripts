# Health Monitoring

The control plane includes a built-in health monitoring system that tracks the
status of all managed infrastructure. This document covers the monitoring
architecture, what gets probed, and the contract for monitored targets.

## Architecture

```
┌─────────────────────┐
│  Admin UI            │
│  (Monitoring tab)    │
│                      │
│  ┌────────────────┐  │
│  │ Health Probe    │──┼──→ Worker Nodes (SSH)
│  │ Loop            │──┼──→ Apps (HTTP health endpoint)
│  │                 │──┼──→ Container Workloads (docker status)
│  │                 │──┼──→ Service Profiles (HTTP reachability)
│  └───────┬────────┘  │
│          │           │
│          ▼           │
│  ┌────────────────┐  │
│  │ Postgres        │  │  ← time-series storage (health_checks table)
│  │ (external)      │  │
│  └────────────────┘  │
│  ┌────────────────┐  │
│  │ Redis           │  │  ← snapshot cache (optional)
│  │ (external)      │  │
│  └────────────────┘  │
└─────────────────────┘
```

## Probe Targets

The monitoring system automatically discovers targets from `gateway.config.json`:

### Worker Nodes

- **Method**: SSH connectivity test
- **Healthy**: SSH connection succeeds
- **Down**: SSH connection fails or times out

### Apps (Blue/Green)

- **Method**: HTTP GET to the health endpoint on the **active slot** port
- **Healthy**: 2xx response within timeout
- **Degraded**: Slow response or intermittent failures
- **Down**: Connection refused, timeout, or non-2xx response

The probe reads the `current-slot` file for each app to determine which slot
port to check. It does not probe the inactive slot.

### Container-Service Workloads

- **Method**: Docker container status check via SSH to the worker node
- **Healthy**: All containers in the workload compose project are running
- **Degraded**: Some containers running, some stopped
- **Down**: No containers running or node unreachable

### Minecraft Bedrock Server Workloads

- **Method**: Docker container status check via SSH to the worker node
- **Healthy**: Server container status contains "Up"
- **Down**: Container stopped, exited, or node unreachable

### Service Profiles

- **Method**: HTTP reachability to configured base URLs
- **Healthy**: Endpoint responds with 2xx
- **Down**: Connection refused or timeout

## Data Storage

### Postgres (Required)

Health check results are stored in the `health_checks` table:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial | Primary key |
| `target_kind` | text | `node`, `app`, `workload`, `service-profile` |
| `target_id` | text | Identifier matching config |
| `status` | text | `healthy`, `degraded`, `down`, `unknown` |
| `response_time_ms` | integer | Probe response time |
| `details` | jsonb | Probe-specific metadata |
| `checked_at` | timestamptz | When the check ran |

Migrations are in `migration/metrics/` and run automatically on startup.

### Redis (Optional)

When available, a cached health snapshot is stored in Redis with a 120-second
TTL. This speeds up dashboard renders without hitting Postgres on every page
load. If Redis is unavailable, the system falls back to direct Postgres queries.

## Configuration

Monitoring is configured in the `monitoring` section of `gateway.config.json`:

```json
{
  "monitoring": {
    "enabled": true,
    "postgres": {
      "host": "<postgres-host>",
      "port": 5432,
      "database": "<database-name>",
      "user": "<user>",
      "password": "<password>"
    },
    "redis": {
      "host": "<redis-host>",
      "port": 6379
    },
    "healthCheckIntervalSeconds": 60
  }
}
```

- `enabled`: Master switch. When false, no probes run and no connections open.
- `postgres`: Required when enabled. Connection details for the health
  time-series database.
- `redis`: Optional. When omitted or unreachable, caching is skipped gracefully.
- `healthCheckIntervalSeconds`: How often the background probe loop runs.

## Uptime Calculation

The monitoring system calculates 24-hour uptime percentages per target:

```
uptime = (healthy checks in last 24h) / (total checks in last 24h) × 100
```

This is displayed in the admin UI's Monitoring tab.

## Data Retention

Old health check records are automatically purged based on a configurable
retention period. The purge runs periodically alongside the health probe loop.

## Benchmark System

Alongside health monitoring, the system supports performance benchmarks:

- **Benchmark runs**: Named test sessions with start/end times
- **Benchmark results**: Individual measurements within a run (latency, throughput, etc.)

This is used for tracking inference service performance (STT, TTS, LLM) over
time. Benchmarks are stored in `benchmark_runs` and `benchmark_results` tables.

## Admin UI Integration

The Monitoring tab in the admin UI provides:

- Live health status grid showing all targets
- 24-hour uptime percentages
- Response time history
- "Run Check Now" button for on-demand probes
- Monitoring settings configuration
- Benchmark run management

## Contract for Monitored Services

If your app or workload is managed by this control plane:

1. **Keep your health endpoint fast** — probes time out after a few seconds
2. **Return 2xx when healthy** — any non-2xx is treated as failure
3. **Health should reflect readiness** — don't return 200 if the service can't
   handle requests (e.g., still loading models)
4. **Don't rate-limit the health endpoint** — it's called every
   `healthCheckIntervalSeconds` from one source
