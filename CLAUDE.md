# Dreamsy — agent notes

Read DREAMSY.MD first; it is the source of truth for architecture and decisions.

- Game package format (`format/`) is the central contract. Never change it without updating DREAMSY.MD §3.
- Engine is `engine-web/` (TypeScript + three.js + Rapier + Luau→WASM). `core/` must stay DOM-free (runs in Node for servers and harness playtests). 2D first; 3D later.
- `third_party/` is vendored; don't modify.
- Build one component at a time; don't start the next slice unasked.
- Don't start servers; the user runs them.
