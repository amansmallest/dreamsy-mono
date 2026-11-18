# Dreamsy — agent notes

Read DREAMSY.MD first; it is the source of truth for architecture and decisions.

- Game package format (`format/`) is the central contract. Never change it without updating DREAMSY.MD §3.
- The engine is `engine/` (C++20, restricted style, DREAMSY.MD §14). 2D and 2.5D only; no 3D. The TypeScript engine (`engine-web/`) was deleted 2026-11-18 (tag `engine-web-final`); `engine/tests/conformance/golden` keeps its reference outputs.
- The user knows TypeScript and Python and is learning C++: keep C++ clean and simple, and explain C++ primitives when asked.
- `third_party/` is vendored; don't modify.
- Build one component at a time; don't start the next slice unasked.
- Don't start servers; the user runs them.
