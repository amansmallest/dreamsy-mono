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
```

Layout: `route.ts` (Haiku classifier + model plans) · `agent.ts` (tool loop) · `workspace.ts`
(working package, ops, async images) · `prompt.ts` (cached system prompt: role, Luau API, catalog, style) ·
`generate.ts` (route → agent → escalate → summary) · `worker.ts` (API protocol, heartbeats, cancel) ·
`images.ts` (Gemini).

## Continual improvement (retrieval, not training)
- `src/memory.ts` — `Memory {remember, recall, forget}`: Supermemory when `SUPERMEMORY_API_KEY` is set, else a
  JSON-lines store in `.data/memory/` (BM25 + kit/pack/genre overlap; deterministic). `DREAMSY_MEMORY=0` disables.
  Scopes: `dreamsy:global`, `kit:`, `pack:`, `game:`, `user:` — `user:` items are only recalled for that user.
- `src/lessons.ts` — after each round: Haiku-written build lessons (global, never prompt text), an outcome, and for
  edits a user-scoped remix record (parent version, instruction, ops/files, result). Recalled into the first
  message as "# What worked before" (+ `memory` event). Tags with > 12 lessons are merged by Haiku and the
  originals superseded.
- `src/sprites.ts` — shipped SVG sprites go to `.data/sprites/` + a Memory index with the build's art score;
  the builder's `find_sprites` tool returns well-scored ones to adapt (`draw_sprite {from}` counts the reuse).
- The worker sends one `metrics` event per job → `GET /v1/me/insights` / `GET /v1/insights/engine` (services/api).
