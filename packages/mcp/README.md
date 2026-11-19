# dreamsy-mcp

Make 2D and 2.5D games with your own AI assistant. `dreamsy-mcp` gives any MCP client (Claude Code, Claude Desktop,
Cursor, …) the [Dreamsy](https://github.com/apoorvcodes/dreamsy-mono) game engine as tools: start from one of 21 genre
kits, edit scenes and Luau scripts, draw pixel sprites, playtest headless, check and export a game you can share.

It runs on your machine. Your assistant's own model does the building, so there is no Dreamsy account, key or server.

## Install

```sh
claude mcp add dreamsy -- npx -y dreamsy-mcp
```

Other clients: run `npx -y dreamsy-mcp` as a stdio server. Then ask something like
“build a cozy frog platformer with dreamsy”.

Games are saved as folders in the directory the server starts in. Set `DREAMSY_GAMES_DIR` to keep them elsewhere:

```sh
claude mcp add -e DREAMSY_GAMES_DIR=$HOME/dreamsy-games dreamsy -- npx -y dreamsy-mcp
```

## Tools

| Tool | What |
|---|---|
| `dreamsy_options` | kits, art styles and style packs to start from |
| `create_game` | a new game from a kit's example, or empty |
| `dreamsy_guide` | the format, edit ops, entity catalog, Luau API, style and kit docs for a game |
| `game_outline`, `read_files`, `get_entities` | look at a game |
| `apply_ops`, `draw_sprite` | edit a game; a batch applies only if the package stays valid |
| `playtest` | run the game headless (screenshots too when `playwright` is installed) |
| `check_game` | the release check: valid package and a smoke run with no script errors |
| `export_game` | write a `.dpk` file you can play and share |

## Platforms

Prebuilt engine binaries: macOS (Apple Silicon, macOS 12+) and Linux x64. Elsewhere, build `dreamsy-tool` from source
(see the repo's `engine/README.md`) and set `DREAMSY_TOOL` to its path.

Screenshots during playtests need Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`);
without it, playtests still run and report errors, scenes, controls and sound.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0): free for personal, hobby,
research, educational and nonprofit use; no commercial use. Bundled third-party software and its licenses are listed in
`THIRD-PARTY-NOTICES.txt`.
