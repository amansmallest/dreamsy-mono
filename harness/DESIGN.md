# Harness design (v0)

Turns a prompt + reference images into a validated game package version.
Stateless TypeScript workers pull jobs from `services/api` (worker protocol in `services/api/README.md`).

```
            ┌──────────── worker process ─────────────────────────────────────────┐
API ─claim─►│ 1 route (Haiku) → 2 build context → 3 agent loop (Opus|Sonnet)      │
            │                                      │ tools: read / apply_ops /     │
            │                                      │ validate / gen_image / playtest│
            │ 4 final gate (validate + boot*) → 5 summary (Haiku) → complete      │
            └──────────── events (heartbeat + progress) ─► API ─SSE─► app ───────┘
                                                            * once engine harness build exists
```

## 1. Route — Claude Haiku 5.5, ~1s

One structured-output call classifies the request and pre-checks it:

| field | values |
|---|---|
| `kind` | `new_game` · `feature` (new mechanic/level/system) · `tweak` (props, text, colors, numbers, small script edit) · `asset` (regenerate art only) · `reject` |
| `style` | preset guess for new games when the user didn't pick one |
| `safety` | ok / reason — prompt moderation pre-check (real moderation pipeline later, DREAMSY.MD §7) |

Routing table:

| kind | model | effort | turn cap | typical time |
|---|---|---|---|---|
| new_game | Opus 5.5 | high | 40 | 2–5 min |
| feature | Opus 5.5 | medium | 25 | 1–2 min |
| tweak | Sonnet 5.5 | low | 8 | 10–30 s |
| asset | Sonnet 5.5 | low | 6 | 15–40 s (image-bound) |

If a cheap run fails its final gate twice, escalate once to the next tier before failing the job.

## 2. Context (prompt-cache friendly, stable → volatile)

1. **System (cached, frozen per format version):** role; package format rules; ops reference;
   full entity catalog (`format/catalog.json`); Luau scripting API reference; "how to build good small games"
   playbook (core loop first, juice later, always a camera + win/lose condition + HUD).
2. **Style block (cached per preset):** `STYLES[preset].build` + palette + notes.
3. **Game context:** manifest, scene outline (ids/types/names tree, not full props), script file list.
   Full files are read on demand via tools — keeps context small on big games.
4. **User turn:** prompt, reference images (image blocks), tapped `selection` ids (expanded in full).

## 3. Agent loop

Manual loop over the Messages API (streaming, adaptive thinking, `eager_input_streaming` on tools,
`task_budget` for new games), not the SDK tool runner — we need per-turn control for
lease heartbeats, cancellation (any 409 from the API → abort), cost accounting and progress events.

Tools (all `strict`):

| tool | does |
|---|---|
| `read_files {paths}` | file contents (scenes, scripts, data, asset metas) |
| `get_entities {ids}` | full JSON for specific entities + their children ids |
| `apply_ops {ops, reason}` | `parseOps` → `applyOps` → `validatePackage`; returns op error (with index) or the new issue list. Working package only advances on success. |
| `generate_image {id, prompt, size, transparent}` | Gemini image with the style's `assetPrompt` + palette + style reference images; stores via `put_asset`. Runs async — several in flight while Claude keeps building. |
| `generate_mesh {id, prompt}` | later: Gemini views → image-to-3D → glb. Disabled for `blocky`/`clean` (primitives first). |
| `playtest {seconds, inputs?}` | later: boots the package in the headless engine (harness build), returns runtime errors + a screenshot as an image block, so Claude *sees* the game. |
| `finish {summary}` | ends the loop; triggers the final gate. |

Working state lives in the worker (`Package` in memory); nothing is uploaded until the gate passes.

## 4. Final gate

`validatePackage` must be error-free → (later) Luau compile of every script → (later) headless boot
for N seconds with no runtime errors. Failures go back into the loop as a tool result, up to the
turn cap. Then: deterministic zip → `POST /complete`.

## 5. Summary — Haiku 5.5

One line for the version history ("Added 3 cat towers and a gold counter") from the op log.

## Progress events (→ app over SSE)

`route` · `plan` (Claude's short plan) · `ops` (counts: +entities, ~props, scripts touched) ·
`asset.started` / `asset.done` (thumbnail url later) · `validate` (error count) · `playtest` (screenshot) ·
`cost` (tokens, $). Every event also renews the job lease.

## Cost & limits

- Per-generation token + $ accounting in events; hard $ cap per job by kind.
- Prompt caching on system + style blocks (shared across all jobs of a preset).
- Rough targets to measure against: new game ≈ $0.50–2, tweak ≈ $0.02–0.10 (+ images).

## Not in v0

Moderation pipeline beyond the Haiku pre-check · mesh generation · audio · playtest/boot
(needs engine harness build) · multi-agent parallel building (assets already run in parallel).
