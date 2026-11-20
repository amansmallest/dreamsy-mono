#!/bin/sh
set -e
mkdir -p /data/games /data/dreamsy
if [ -z "$(ls -A /data/games 2>/dev/null)" ] && [ -d /app/deploy/fly/artifacts/seed/games ]; then
  cp -R /app/deploy/fly/artifacts/seed/games/. /data/games/
  [ -f /app/deploy/fly/artifacts/seed/links.json ] && [ ! -f /data/dreamsy/games.json ] && cp /app/deploy/fly/artifacts/seed/links.json /data/dreamsy/games.json
  echo "seeded games: $(ls /data/games | wc -l)"
fi
cd /app/apps/site
exec node_modules/.bin/next start -p "${PORT:-8080}" -H 0.0.0.0
