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
sudo docker image rm home-automation-gateway:blue home-automation-gateway:green 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl reload nginx
```

## Fresh Repo Setup

Clone this repo to a stable path such as:

```bash
/opt/gateway-control-plane
```

Then run:

```bash
cd /opt/gateway-control-plane
npm run validate
npm run build
```

The generated output is then available for installation or further customization.

