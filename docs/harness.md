# Dreamsy — Generation (the harness)

Part of the Dreamsy spec. Section numbers are shared across the spec files; [DREAMSY.MD](../DREAMSY.MD) maps each
section to its file.

## 5. Generation

### 5.1 Harness

- Runs in the cloud. Input: user prompt, reference images, current package version, user
  selection (e.g. tapped entity IDs). Output: validated diff-op batches.
- **Opus 5.5** orchestrates: game design, scene construction, all Luau logic, asset requests.
- **Smaller models** handle cheap, frequent work: small edits, naming, metadata, moderation pre-checks.
- Loop: plan → emit ops → validate (schema, typecheck, headless boot test, scripted smoke play)
  → fix → commit version → push to client for hot reload.
- **Playtests run on the C++ engine (2026-11-18):** the builder's `playtest` tool and the final gate (8 s smoke
  run, zero script errors) use `dreamsy-tool playtest <pkg> --timeline <json>` (headless, `harness/src/playtest.ts`):
  timeline steps `{t, hold?, release?, press?, tap?: [x,y], swipe?: {from,to,seconds?}}` in game time, taps through
  `Host::tap_screen`; the JSON report has script errors (script/line/count), last logs, toasts, entity count,
  sfx counts + music, the avatar's position per second, dialog lines shown (auto-advanced) and the one open at
  the end, final save data, the scenes visited, and the controls the game read. Options: `--seconds --scene
  --params --save --clock --auto-dialog --budget --seed` (start mid-game). Screenshots come from the C++ web
  player in headless Chromium (`harness/src/browser.ts`: Playwright `page.route`, no server, `?manual=1` +
  `window.__dreamsy.step`, `?scene=&params=&save=`), at game times, so 2.5D games are seen as players see them.
  Kit balance simulators (`kits/<kit>/harness.ts`) run Luau through `dreamsy-tool eval`.
- **OPEN:** harness language. Leaning TypeScript (Claude Agent SDK; shares types with web app).

### 5.2 Assets

Opus directs, specialized models make. Opus does not hand-build meshes except simple/procedural ones.

- **2D** (sprites, textures, UI, icons): Gemini image model, with style locked per game from
  the reference images.
- **3D**: Gemini generates reference views → image-to-3D (Hunyuan3D / Trellis self-hosted,
  or Tripo / Meshy API) → cleanup (decimate, UV, compress) → glTF. Characters → auto-rig.
- Audio: **OPEN**.
- Every asset gets `.meta.toml` provenance. Assets are content-addressed and reusable across games.

### 5.3 Cost

Every creator generating is the business risk. Per-user generation quota, small models for
iteration, Opus for builds and hard logic, aggressive caching of assets and plans.
