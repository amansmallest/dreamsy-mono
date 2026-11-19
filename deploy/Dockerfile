# One image for the API, the harness worker and the room server, plus the C++ engine: dreamsy-tool (headless
# playtests and kit simulations for the worker) and the web player (the app's WebView, share links and the worker's
# browser screenshots; Caddy serves it at play.<domain>, see docker-compose.yml `player`).
#   docker build -f deploy/Dockerfile -t dreamsy .
#   API:    CMD default        worker: command ["pnpm","-C","harness","worker"]    gameserver: ["pnpm","-C","services/gameserver","start"]

# ---- what engine/CMakeLists.txt reads: the engine, vendored deps, the kit catalog + type defs, the kits, the demo package
FROM ubuntu:24.04 AS engine-src
WORKDIR /src
COPY engine engine
COPY third_party third_party
COPY format/catalog.json format/dreamsy.d.luau format/
COPY kits kits
COPY games/examples/feature-demo games/examples/feature-demo

# ---- dreamsy-tool (native, release)
FROM ubuntu:24.04 AS tool
RUN apt-get update && apt-get install -y --no-install-recommends cmake ninja-build clang python3 && rm -rf /var/lib/apt/lists/*
COPY --from=engine-src /src /src
RUN cd /src/engine && CC=clang CXX=clang++ cmake --preset release -DDREAMSY_BUILD_PLAYER=OFF -DDREAMSY_BUILD_TESTS=OFF \
 && cmake --build --preset release --target dreamsy-tool

# ---- the C++ web player (engine/apps/player, Emscripten 4.0.11 like CI and engine/README.md)
FROM emscripten/emsdk:4.0.11 AS player
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build && rm -rf /var/lib/apt/lists/*
COPY --from=engine-src /src /src
RUN emcmake cmake -S /src/engine -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DDREAMSY_BUILD_TESTS=OFF \
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
# Where the repo's scripts expect the engine (harness playtests, seed-showcase covers, docker-compose `player`).
COPY --from=tool /src/engine/build/release/dreamsy-tool /app/engine/build/release/dreamsy-tool
COPY --from=player /out /app/engine/build/web
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["sh", "-c", "pnpm -s -C services/api db:migrate && pnpm -s -C services/api start"]
