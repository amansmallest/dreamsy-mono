# Dreamsy — agent notes

Read DREAMSY.MD first; it is the source of truth for architecture and decisions.

- Game package format (`format/`) is the central contract. Never change it without updating DREAMSY.MD §3.
- Shipping engine is `engine-web/` (TypeScript + three.js + Rapier + Luau→WASM). `core/` must stay DOM-free (runs in Node for servers and harness playtests).
- Engine v2 is `engine/` (C++20, restricted style, DREAMSY.MD §14). 2D and 2.5D only; no 3D.
- The user knows TypeScript and Python and is learning C++: keep C++ clean and simple, and explain C++ primitives when asked.
- `third_party/` is vendored; don't modify.
- Build one component at a time; don't start the next slice unasked.
- Don't start servers; the user runs them.
