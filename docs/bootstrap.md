# Bootstrap

This repo assumes a fresh Debian-based gateway host with no application-specific
software already configured.

## Host Prerequisites

Install these on the gateway host:

- `git`
- `curl`
- `jq`
- `nginx`
- `docker.io`
- `docker-compose-plugin`
- `nodejs`
- `npm`

Node 24+ is required because the control-plane CLI uses native TypeScript
execution.

## Clean Up Earlier False Start

If you already started the old Python/HA-oriented setup on the gateway, remove
it before proceeding:

```bash
sudo systemctl disable --now gateway-blue.service gateway-green.service || true
sudo rm -f /etc/systemd/system/gateway-blue.service /etc/systemd/system/gateway-green.service
sudo rm -rf /etc/home-automation
sudo rm -f /etc/nginx/sites-enabled/gateway /etc/nginx/sites-available/gateway
sudo rm -f /etc/nginx/conf.d/gateway-active-upstream.conf
sudo rm -rf /opt/home-automation-scripts/.venv
sudo rm -rf /opt/home-automation-scripts
sudo docker image rm home-automation-gateway:blue home-automation-gateway:green 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl reload nginx
```

## Fresh Repo Setup

Clone this repo to a stable path such as:

```bash
/opt/gateway-control-plane
```

Example:

```bash
cd /opt
sudo git clone https://github.com/goblinsan/gateway-control-plane.git /opt/gateway-control-plane
sudo chown -R "$USER":"$(id -gn)" /opt/gateway-control-plane
```

Then run:

```bash
cd /opt/gateway-control-plane
cp configs/gateway.config.example.json configs/gateway.config.json
npm run validate
node src/cli.ts build --config configs/gateway.config.json --out generated
```

For one-off interactive config editing, you can also run:

```bash
node src/cli.ts serve-ui --config configs/gateway.config.json --host 0.0.0.0 --port 4173 --out generated
```

and browse to `http://<gateway-lan-ip>:4173`.

For the intended managed setup, clone the companion app repos into stable host
paths as well:

```bash
sudo git clone https://github.com/goblinsan/gateway-api.git /opt/gateway-api
sudo git clone https://github.com/goblinsan/gateway-chat-platform.git /opt/gateway-chat-platform
sudo chown -R "$USER":"$(id -gn)" /opt/gateway-api /opt/gateway-chat-platform
```

Then install and enable the real host prerequisites for Docker deployments:

```bash
sudo systemctl enable --now docker
sudo systemctl enable --now nginx
```

The intended production model is to keep `gateway.adminUi.enabled` disabled and
deploy `gateway-control-plane` itself through the same blue/green Docker flow as
the other apps.

If you need a temporary singleton admin UI during bootstrap, the legacy systemd
service path still exists:

```bash
deploy/bin/install-control-plane-service.sh --config configs/gateway.config.json
```

But once Docker blue/green is in place, the preferred deploy flow is separate
hostnames per app, for example:

- `admin.gateway.example.test`
- `api.gateway.example.test`
- `chat.gateway.example.test`

The generated nginx config still supports the shared fallback paths:

- `/admin/`
- `/api/`
- `/chat/`

but separate hostnames are cleaner for browser clients because they avoid
sharing the same cookie jar across the admin and chat UIs. All three are still
promoted by nginx upstream switching rather than by restarting singleton
processes on fixed ports.
