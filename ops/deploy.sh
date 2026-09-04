#!/usr/bin/env bash
#
# binge.shanuva.com — production deploy. Runs ON the shanuva server (Contabo).
#
# Stage 1 updates the git checkout, then re-execs the FRESH copy of this
# script (bash reads scripts incrementally — never keep executing a file
# that git just rewrote). Stage 2 builds and starts the container.
#
# Usage:  BRANCH=main /srv/binge/repo/ops/deploy.sh

set -euo pipefail

REPO_DIR="${REPO_DIR:-/srv/binge/repo}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-https://binge.shanuva.com}"

info() { printf '\033[0;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[ ok  ]\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[fail ]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$REPO_DIR/.git" ]] || die "not a git checkout: $REPO_DIR"

cd "$REPO_DIR"

if [[ -z "${DEPLOY_STAGE2:-}" ]]; then
  info "updating checkout to origin/$BRANCH"
  git fetch origin "$BRANCH"
  # Runs hourly from cron so the nightly catalogue sync goes live within the
  # hour instead of waiting for tomorrow. Bail out cheaply when there is
  # nothing new and the site is up (FORCE=1 to rebuild anyway).
  if [[ -z "${FORCE:-}" && "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$BRANCH")" ]] \
     && curl -fsS -o /dev/null "$HEALTH_URL"; then
    ok "already at $(git rev-parse --short HEAD) and healthy — nothing to deploy"
    exit 0
  fi
  git checkout -q "$BRANCH"
  git reset --hard "origin/$BRANCH"
  ok "at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
  DEPLOY_STAGE2=1 exec bash "$REPO_DIR/ops/deploy.sh"
fi

# ---- Stage 2 (fresh copy of the script) ----

info "building images"
sudo docker compose -f docker-compose.prod.yml build --pull

info "starting"
sudo docker compose -f docker-compose.prod.yml up -d

info "waiting for health check"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then
    ok "healthy: $HEALTH_URL"
    exit 0
  fi
  sleep 3
done
die "health check never passed: $HEALTH_URL"
