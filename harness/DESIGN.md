# Harness design

Turns a prompt (plus reference images, an existing game and tapped entities) into a validated game package.
Spec: docs/harness.md §5.

## Flow

```
cli/main.ts ─┬─ worker: jobs/worker.ts claims API jobs, runs rounds, uploads versions + progress events
             └─ local:  one build on this machine, no API
mcp/server.ts   the engine as MCP tools: the user's own client and model build the game (docs/harness.md §5.4)

pipeline/generate.ts   one round
  1. route      pipeline/route.ts: Haiku classifies the request (new_game · feature · tweak · asset · reject)
                and picks kits, style, style pack, orientation, safety
  2. template   context/templates.ts: a new game starts as its kit's example game
  3. agent      agent/loop.ts with a plan from pipeline/plans.ts (model, effort, turn cap, $ cap);
                one retry on a stronger model when the build fails on quality
  4. after      Haiku summary line · thumbnail · shipped sprites → library · lessons → memory
```

New games run several rounds: each one builds the next unchecked milestones in the game's `notes.md`.

## The agent

`agent/brief.ts` writes the first message: the game outline, the request, reference images, style-pack art, a
screenshot of the current game (edits), and lessons recalled from memory. The system prompt
(`context/prompt.ts`) holds the format rules, the entity catalog, the Luau API, the style and the kit docs; it is
identical on every turn so it stays cached.

`agent/loop.ts` runs the turns: streaming, effort per plan, fast mode on Opus, retries on malformed tool
input, a cost cap, a nudge when the model stops without `finish`. Each tool call goes to its file in
`agent/tools/`, which defines the tool once (zod input → the JSON Schema the model sees, label, handler):

| Tool | File | Does |
|---|---|---|
| `read_files`, `get_entities` | files.ts | look at the game |
| `apply_ops` | apply-ops.ts | edit the game; the batch applies only if the package stays valid |
| `draw_sprite`, `find_sprites` | sprites.ts | SVG art; reuse sprites from past well-reviewed builds |
| `generate_image` | images.ts | Gemini images in the background (placeholder until done) |
| `build_content` | content.ts | parallel Sonnet builders for bulk items, checked against kit schemas |
| `playtest` | playtest.ts | headless run + screenshots on the C++ engine |
| `finish` | finish.ts | final gate (`agent/final-gate.ts`: valid package, 8 s smoke run with no script errors), then one art-director review (`agent/critique.ts`) |

The working copy is `agent/workspace.ts`; nothing leaves the worker until a round passes the final gate.

## Modules

| Folder | What |
|---|---|
| `cli/` | entry point: `worker` and `local` |
| `mcp/` | MCP server: engine tools for any MCP client, no model key |
| `jobs/` | the API worker protocol: claim, heartbeat, events, upload, cancel |
| `pipeline/` | one round (`generate.ts`), the router, the model plans |
| `agent/` | brief, loop, tools, workspace, final gate, art critique, content builders |
| `context/` | what the model is told: system prompt, kits, taste packs, kit templates, content schemas |
| `engine/` | playtests on the C++ engine: `dreamsy-tool playtest` (headless) and the web player in Chromium |
| `llm/` | model clients (Anthropic, OpenAI, account failover), Gemini images, prices and cost meter |
| `memory/` | retrieval memory (Supermemory or `.data/memory`), build lessons, the sprite library |
| `env.ts`, `paths.ts` | `.env` loading, repo paths |

## Progress events

`route` · `template` · `plan` · `working` · `ops` · `sprite` · `sprites.found` · `asset.started/done/failed` ·
`content` · `playtest` · `validate` · `review` / `review.done` · `memory` / `memory.saved` · `cost` · `escalate` ·
`note`; the worker adds `heartbeat`, `eta`, `cost.final` and one `metrics` per job. The app and studio render them as a timeline.

## Next

Keys per job instead of per process (bring your own key), one typed config object instead of env reads, `.dpk`
output, and a `dreamsy create` command for local builds.
