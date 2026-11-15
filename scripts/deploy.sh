#!/usr/bin/env bash
# Push the current code to the production box and rebuild/restart (data is kept).
#   ./scripts/deploy.sh                 everything (restarts workers: running builds are interrupted!)
#   ./scripts/deploy.sh --keep-workers  API + web + engine only; build workers keep running their jobs
#   --no-engine                         don't republish the engine at play.dreamsy.dev
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP=0; ENGINE=1; for a in "$@"; do case "$a" in --keep-workers) KEEP=1;; --no-engine) ENGINE=0;; esac; done
# Web dashboard → dreamsy.dev (built here with apps/web/.env.local: prod API, Convex)
grep -q "^VITE_API_URL=https://api.dreamsy.dev" apps/web/.env.local || { echo "apps/web/.env.local must point VITE_API_URL at https://api.dreamsy.dev"; exit 1; }
pnpm -s -C apps/web exec vite build --logLevel warn
ssh dreamsy-ec2 'mkdir -p /srv/dreamsy/web'
rsync -az --delete apps/web/dist/ dreamsy-ec2:/srv/dreamsy/web/
rsync -az --delete --exclude node_modules --exclude .git --exclude apps --exclude .dev-logs --exclude .data \
  --exclude '*credentials*' --exclude '.env' --exclude '.env.local' --exclude 'harness/.env' --exclude 'services/api/.env' \
  --exclude engine-web/dist ./ dreamsy-ec2:dreamsy/
if [ "$KEEP" = 1 ]; then UP='$C build api && $C up -d --no-deps api gameserver && $C up -d --no-deps --force-recreate caddy'; else UP='$C up -d --build'; fi
ssh dreamsy-ec2 "cd dreamsy && C='docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod' && $UP && docker image prune -f >/dev/null"
[ "$ENGINE" = 1 ] && ssh dreamsy-ec2 "cd dreamsy && C='docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod' \
  && rm -rf /srv/dreamsy/engine.new && \$C cp api:/app/engine-web/dist /srv/dreamsy/engine.new \
  && mkdir -p /srv/dreamsy/engine && rsync -a --delete /srv/dreamsy/engine.new/ /srv/dreamsy/engine/ && rm -rf /srv/dreamsy/engine.new"  # in place: Caddy bind-mounts it
curl -sf https://api.dreamsy.dev/health || curl -sf http://15.252.199.188/health
