# Kits

A kit is a tested, versioned Luau library shipped with the engine (docs/kits.md §12.1). Games opt in with
`kits = ["<kit>"]` in `dreamsy.toml` and `require("@kit/<kit>")` (or `require("@kit/<kit>/<module>")`).
The shipped list is `KITS` in `format/src/kits.ts` (the validator rejects anything else).

```
kits/<kit>/
  init.luau            the API: require("@kit/<kit>") returns what this returns
  <module>.luau        submodules: require("@kit/<kit>/<module>"); a folder with init.luau works too
                       (`battle/init.luau` = "@kit/rpg/battle"; nested: "@kit/rpg/battle/moves")
  kit.json             { "requires": ["core", "progression"] } — dependencies, enabled automatically when a game lists the
                       kit (transitively; engine expandKits, format registerKitDependencies). Every kit has one ([] = none).
  KIT.md               API reference the harness injects into the prompt (systems, data formats,
                       example snippets, extension points, do/don't)
  schemas/*.json       JSON Schemas for the kit's content files in game packages (data/<area>/*.json); kits read them at
                       runtime with data.list / data.read — never generate scripts/shared/*content*.luau copies
  example/             a small complete game package using the kit (also a golden test)
engine/tests/kits/<kit>_test.cpp    headless core tests (C++ doctest, run_luau / simulate helpers in kit_test.h)
kits/<kit>/harness.ts, cli.ts        optional headless helpers (balance sims) on the C++ engine via kits/_tools/engine.ts
                                     (`dreamsy-tool eval`: runs a Luau script in a package with the kit enabled)
games/examples/kit-<kit>/            optional showcase package
```

Rules
- Kit modules run in the same sandbox as game scripts, with the full LUAU_API.md surface
  (entities, input, ui.dialog, tween, save, camera, …). They are read-only to games.
- Modules load once per game (cached, survive `loadScene`), like `scripts/shared` modules.
- Inside a kit, `require("./battle")` / `require("../util")` resolve relative to the module and may not
  leave `kits/<kit>/`; `require("@kit/<kit>/battle")` works too. Kits can't require game scripts —
  games pass content/config in (data-driven: content lives in the game's `data/<area>/*.json`).
- Expose hooks/events (callbacks or signal-like tables) for custom behaviour instead of forcing forks.
- Build on the foundation kits (core: events, save sections, content, menus; progression; juice; combat; ai; procgen)
  instead of re-implementing them, and declare them in kit.json.
- Deterministic: use `random()` / `math.random` (seeded) and `onTick` / timers; wall clock only via `clock.now()`
  (daily rewards, offline progress — tests inject it with `Game.load(pkg, { clock })`).
- Long-lived systems created from entity scripts: wrap registration in `game.session(fn)`.
- Bundling: sources are collected by Vite's `import.meta.glob("../kits/**/*.luau")` (browser + vitest)
  and read from disk under plain Node (`core/kits.ts`). Tests can inject sources with `setKitSources`.

Start from `_template/` (copy it to `kits/<kit>/`; folders starting with `_` are never loadable).
