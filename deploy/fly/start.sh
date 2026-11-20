#!/bin/sh
set -e
mkdir -p /data/games /data/dreamsy
if [ -z "$(ls -A /data/games 2>/dev/null)" ] && [ -d /app/deploy/fly/artifacts/seed/games ]; then
  cp -R /app/deploy/fly/artifacts/seed/games/. /data/games/
  [ -f /app/deploy/fly/artifacts/seed/links.json ] && [ ! -f /data/dreamsy/games.json ] && cp /app/deploy/fly/artifacts/seed/links.json /data/dreamsy/games.json
  echo "seeded games: $(ls /data/games | wc -l)"
fi
# The hosted MCP server (dreamsy.dev/mcp, proxied by the site's rewrite): its own process, restarted if it dies.
# It makes an anonymous save key per session, so it gets no access to the editor's DREAMSY_SAVE_KEY.
mkdir -p /data/mcp
(cd /app/harness && while true; do
  env -u DREAMSY_SAVE_KEY DREAMSY_MCP_DIR=/data/mcp DREAMSY_MCP_PORT=8090 node --import tsx src/mcp/http.ts || true
  echo "dreamsy mcp exited; restarting"
  sleep 2
done) &

cd /app/apps/site
exec node_modules/.bin/next start -p "${PORT:-8080}" -H 0.0.0.0
