# One image for the API, the harness worker and the room server, plus the C++ web player (the game player for the
# app's WebView and share links; Caddy serves it at play.<domain>, see docker-compose.yml `player`).
#   docker build -f deploy/Dockerfile -t dreamsy .
#   API:    CMD default        worker: command ["pnpm","-C","harness","worker"]    gameserver: ["pnpm","-C","services/gameserver","start"]

# ---- the C++ web player (engine/apps/player, Emscripten 4.0.11 like CI and engine/README.md)
FROM emscripten/emsdk:4.0.11 AS player
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# What engine/CMakeLists.txt reads: the engine, vendored deps, the kit catalog + type defs, the kits, the demo package,
# and (until it moves into engine/) the Luau prelude from engine-web.
COPY engine engine
COPY third_party third_party
COPY format/catalog.json format/dreamsy.d.luau format/
COPY kits kits
COPY games/examples/feature-demo games/examples/feature-demo
COPY engine-web/core/prelude.ts engine-web/core/prelude.ts
RUN emcmake cmake -S engine -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /build --target dreamsy-player \
 && mkdir -p /out \
 && cp /build/dreamsy-player.html /build/dreamsy-player.js /build/dreamsy-player.wasm /out/ \
 && cp /build/dreamsy-player.html /out/index.html \
 && cp -r /build/kits /out/kits

# ---- services + harness
FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
RUN npm i -g pnpm@10.4.1
COPY . .
RUN printf 'packages:\n  - services/api\n  - services/gameserver\n  - harness\n  - format\n' > pnpm-workspace.yaml \
 && pnpm install --no-frozen-lockfile --filter @dreamsy/api... --filter @dreamsy/harness... --filter @dreamsy/gameserver...
# Where the repo's scripts expect the web build (seed-showcase covers, docker-compose `player` publishes it to Caddy).
COPY --from=player /out /app/engine/build/web
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["sh", "-c", "pnpm -s -C services/api db:migrate && pnpm -s -C services/api start"]
