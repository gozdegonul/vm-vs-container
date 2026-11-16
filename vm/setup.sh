#!/usr/bin/env bash
# Run INSIDE the Ubuntu Server 24.04 VM, once, after copying server.js and api.service
# to the home directory:   sudo bash setup.sh
# Installs Node.js 22 LTS and registers the API as a systemd service that starts at boot,
# so "VM start -> /health answers" measures a full boot plus application start.
set -euo pipefail

APP_DIR=/opt/api
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

apt-get update
apt-get install -y ca-certificates curl gnupg

# Node.js 22 LTS from the NodeSource repository (same major version as node:22-alpine).
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

mkdir -p "$APP_DIR"
cp "$SRC_DIR/server.js" "$APP_DIR/server.js"
id -u apiuser >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin apiuser
chown -R apiuser:apiuser "$APP_DIR"

cp "$SRC_DIR/api.service" /etc/systemd/system/api.service
systemctl daemon-reload
systemctl enable --now api.service

sleep 1
curl -s http://localhost:8080/health && echo
echo "node version: $(node --version)"
echo "Done. The API now starts automatically at boot."
