#!/usr/bin/env bash
# Template only — do not put real secrets in this file.
# Usage on VPS: set env vars then run, or edit placeholders before upload.
set -euo pipefail

APP_DIR=/var/www/sms-campaign-backend
REPO=https://github.com/eyobsisay/SMS-ampaign-backend.git
DOMAIN=sms.awedaybet.com
APP_PORT=3000
MASTER_USER="${MASTER_ADMIN_USERNAME:-master}"
MASTER_PASS="${MASTER_ADMIN_PASSWORD:?Set MASTER_ADMIN_PASSWORD}"
MASTER_TOKEN="${MASTER_ADMIN_TOKEN:?Set MASTER_ADMIN_TOKEN}"

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl ca-certificates gnupg nginx git ufw

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v(2[2-9]|[3-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p /var/www
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin
  git reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

npm install --omit=dev

cat > "$APP_DIR/.env" <<EOF
PORT=${APP_PORT}
MASTER_ADMIN_USERNAME=${MASTER_USER}
MASTER_ADMIN_PASSWORD=${MASTER_PASS}
MASTER_ADMIN_TOKEN=${MASTER_TOKEN}
JOB_BATCH_SIZE=10
NODE_ENV=production
EOF
chmod 600 "$APP_DIR/.env"
mkdir -p "$APP_DIR/data"

cat > /etc/systemd/system/sms-campaign.service <<EOF
[Unit]
Description=SMS Campaign Portal
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sms-campaign

cat > /etc/nginx/sites-available/sms-campaign <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sfn /etc/nginx/sites-available/sms-campaign /etc/nginx/sites-enabled/sms-campaign
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true

curl -sS "http://127.0.0.1:${APP_PORT}/api/health" || true
echo DONE
