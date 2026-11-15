#!/usr/bin/env bash
# Push the current code to the production box and rebuild/restart (data is kept).
#   ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# Web dashboard → dreamsy.dev (built here with apps/web/.env.local: prod API, Supabase, Convex)
pnpm -s -C apps/web exec vite build --logLevel warn
grep -q "^VITE_API_URL=https://api.dreamsy.dev" apps/web/.env.local || { echo "apps/web/.env.local must point VITE_API_URL at https://api.dreamsy.dev"; exit 1; }
ssh dreamsy-ec2 'mkdir -p /srv/dreamsy/web'
rsync -az --delete apps/web/dist/ dreamsy-ec2:/srv/dreamsy/web/
rsync -az --delete --exclude node_modules --exclude .git --exclude apps --exclude .dev-logs --exclude .data \
  --exclude '*credentials*' --exclude '.env' --exclude '.env.local' --exclude 'harness/.env' --exclude 'services/api/.env' \
  --exclude engine-web/dist ./ dreamsy-ec2:dreamsy/
ssh dreamsy-ec2 'cd dreamsy && docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod up -d --build && docker image prune -f >/dev/null && rm -rf /srv/dreamsy/engine.new && docker compose -f deploy/docker-compose.yml --env-file deploy/.env.prod cp api:/app/engine-web/dist /srv/dreamsy/engine.new && rm -rf /srv/dreamsy/engine && mv /srv/dreamsy/engine.new /srv/dreamsy/engine'
curl -sf https://api.dreamsy.dev/health || curl -sf http://15.252.199.188/health
