# One image for the API and the harness worker (worker needs Chromium + the C++ engine for playtests).
#   docker build -f deploy/Dockerfile -t dreamsy .
#   API:    CMD default        worker: command ["pnpm","-C","harness","worker"]    gameserver: ["pnpm","-C","services/gameserver","start"]

# The C++ engine (DREAMSY.MD §14): dreamsy-tool for headless playtests and kit simulations...
FROM ubuntu:24.04 AS engine-native
RUN apt-get update && apt-get install -y --no-install-recommends cmake ninja-build clang python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cd engine && CC=clang CXX=clang++ cmake --preset release -DDREAMSY_BUILD_PLAYER=OFF -DDREAMSY_BUILD_TESTS=OFF \
 && cmake --build --preset release --target dreamsy-tool

# ...and the web player for browser playtests (screenshots).
FROM emscripten/emsdk:4.0.11 AS engine-web-player
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cd engine && cmake --preset web -DDREAMSY_BUILD_TESTS=OFF && cmake --build --preset web --target dreamsy-player

FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
RUN npm i -g pnpm@10.4.1
COPY . .
RUN printf 'packages:\n  - services/api\n  - services/gameserver\n  - harness\n  - format\n  - engine-web\n' > pnpm-workspace.yaml \
 && pnpm install --no-frozen-lockfile --filter @dreamsy/api... --filter @dreamsy/harness... --filter @dreamsy/gameserver... \
 && pnpm -C engine-web exec vite build --logLevel warn
COPY --from=engine-native /src/engine/build/release/dreamsy-tool /app/engine/build/release/dreamsy-tool
COPY --from=engine-web-player /src/engine/build/web/dreamsy-player.html /src/engine/build/web/dreamsy-player.js /src/engine/build/web/dreamsy-player.wasm /app/engine/build/web/
COPY --from=engine-web-player /src/engine/build/web/kits /app/engine/build/web/kits
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["sh", "-c", "pnpm -s -C services/api db:migrate && pnpm -s -C services/api start"]
