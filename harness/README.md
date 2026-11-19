# harness — cloud game generation

Prompt + reference images → validated game package version. Design: [DESIGN.md](DESIGN.md).

Keys come from the repo-root `.env`: `ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`), optional `GEMINI_API_KEY`
(without it, image generation is off and games use solid colors/primitives).

```sh
# one generation, no API needed — prints progress + cost, writes the package
pnpm local --prompt "a pixel game where a frog collects coins" --out /tmp/frog
pnpm local --prompt "make the frog faster" --base /tmp/frog --select player --out /tmp/frog2
pnpm -C ../format cli validate /tmp/frog

# worker against the API
WORKER_TOKEN=... DREAMSY_API_URL=http://localhost:8787 pnpm worker

pnpm test   # end-to-end: real API (PGlite) + worker + scripted fake model; no network, no cost
PLAYTEST_BROWSER_TEST=1 pnpm test   # also screenshots through the C++ web player
```

## MCP server (bring your own model)

Build games from Claude Code, Claude Desktop or any MCP client with your own model; the server needs no key.

```sh
claude mcp add -e DREAMSY_GAMES_DIR=$HOME/dreamsy-games dreamsy -- pnpm -s -C /path/to/dreamsy/harness mcp
```
Then ask: "build a cozy frog platformer with dreamsy" (or use the `build_game` prompt). Tools and rules:
docs/harness.md §5.4. It needs `dreamsy-tool` built; screenshots also need the web player (below).

Playtests run on the C++ engine (docs/harness.md §5.1). Build it first:

```sh
cd ../engine && cmake --preset release && cmake --build --preset release --target dreamsy-tool   # headless playtests
source ~/emsdk/emsdk_env.sh && cmake --preset web && cmake --build --preset web --target dreamsy-player   # screenshots
```

`src/engine/playtest.ts` runs `dreamsy-tool playtest` (found via `DREAMSY_TOOL`, else `engine/build/{release,headless,debug}`);
`src/engine/browser.ts` drives `engine/build/web/dreamsy-player.html` (or `DREAMSY_WEB_BUILD`) in headless Chromium with
Playwright, stepping game time manually. `PLAYTEST_BROWSER=0` turns screenshots off.

Code layout and the build flow: [DESIGN.md](DESIGN.md).

## Continual improvement (retrieval, not training)
- `src/memory/memory.ts` — `Memory {remember, recall, forget}`: Supermemory when `SUPERMEMORY_API_KEY` is set, else a
  JSON-lines store in `.data/memory/` (BM25 + kit/pack/genre overlap; deterministic). `DREAMSY_MEMORY=0` disables.
  Scopes: `dreamsy:global`, `kit:`, `pack:`, `game:`, `user:` — `user:` items are only recalled for that user.
- `src/memory/lessons.ts` — after each round: Haiku-written build lessons (global, never prompt text), an outcome, and for
  edits a user-scoped remix record (parent version, instruction, ops/files, result). Recalled into the first
  message as "# What worked before" (+ `memory` event). Tags with > 12 lessons are merged by Haiku and the
  originals superseded.
- `src/memory/sprites.ts` — shipped SVG sprites go to `.data/sprites/` + a Memory index with the build's art score;
  the builder's `find_sprites` tool returns well-scored ones to adapt (`draw_sprite {from}` counts the reuse).
- The worker sends one `metrics` event per job → `GET /v1/me/insights` / `GET /v1/insights/engine` (services/api).
