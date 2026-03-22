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

For the intended managed setup, keep `gateway.adminUi.enabled` set in
`configs/gateway.config.json`, then install the control-plane service:

```bash
deploy/bin/install-control-plane-service.sh --config configs/gateway.config.json
```

That installs the configured control-plane service unit into the configured
systemd unit directory and enables it with the configured systemd enable
command.

After that, install the generated nginx site and reload nginx so the control
plane is reachable at the configured route path such as `/admin/`.
