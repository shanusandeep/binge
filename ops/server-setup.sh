#!/usr/bin/env bash
#
# binge.shanuva.com — one-time server provisioning. Run ON the shanuva server
# (Contabo) as a sudo-capable user. Idempotent: safe to re-run.
#
# What it does:
#   1. /srv/binge layout + git checkout of shanusandeep/binge
#   2. binge.shanuva.com route in the shared Caddyfile + reload
#   3. First deploy (build + start container)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/shanusandeep/binge.git}"
APP_DIR="/srv/binge"
REPO_DIR="$APP_DIR/repo"
CADDYFILE="/srv/dailydose/Caddyfile"
DOMAIN="binge.shanuva.com"

info() { printf '\033[0;34m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[ ok  ]\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[fail ]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. layout + checkout ----
info "creating $APP_DIR layout"
sudo mkdir -p "$APP_DIR"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  sudo mkdir -p "$REPO_DIR"
  sudo chown "$(whoami)" "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
  ok "cloned $REPO_URL"
else
  ok "repo already present"
fi

# ---- 2. caddy route ----
if sudo grep -q "^$DOMAIN" "$CADDYFILE"; then
  ok "caddy route already present"
else
  info "adding $DOMAIN route to $CADDYFILE"
  sudo tee -a "$CADDYFILE" > /dev/null <<'EOF'

binge.shanuva.com {
	encode zstd gzip
	reverse_proxy binge-web:80

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		-Server
	}
}
EOF
  ok "route added"
fi

# ---- 3. first deploy (also reloads caddy once the container exists) ----
BRANCH="${BRANCH:-main}" "$REPO_DIR/ops/deploy.sh" || die "deploy failed"

CADDY_CONTAINER=$(sudo docker ps --format '{{.Names}}' | grep -i caddy | head -1)
[[ -n "$CADDY_CONTAINER" ]] && sudo docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile \
  && ok "edge caddy reloaded ($CADDY_CONTAINER)"

ok "done — https://$DOMAIN"
