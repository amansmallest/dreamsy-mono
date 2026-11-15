# Dreamsy design: "Sky"

Shared by `apps/mobile` (`src/theme.ts`, `src/ui`) and `apps/web` (`src/styles/app.css`). Palette from
thoughts.engineering; layout language from game marketplaces like Roblox; pixel art as the accent, never the body.

## Feel
Calm, airy, high-taste. Lots of white space, quiet hairlines, one confident blue. Games are the colour:
the chrome stays out of their way. Pixel touches (pixel clouds, pixel sparkle, pixel-font badges) are
small and deliberate, like a signature.

## Colour
| Token | Hex | Use |
|---|---|---|
| `bg` | `#EFEFED` | app background (warm off-white) |
| `surface` | `#FFFFFF` | cards, sheets, inputs, tab bar |
| `ink` | `#141414` | primary text, icons |
| `navy` | `#0D2A66` | display headings, selected states, dark buttons |
| `blue` | `#4C8DE8` | the one accent: primary buttons, links, progress, active tab, likes-on-blue |
| `sky` | `#A8CBF5` | pastel fills: avatar backgrounds, chips, pixel clouds, highlights |
| `mist` | `#DCE8FA` | faint blue wash: selected rows, empty states, skeletons |
| `muted` | `#6B6F76` | secondary text |
| `faint` | `#A3A6AB` | placeholders, disabled |
| `line` | `#E3E3DF` | hairlines (1px) |
| `ok` | `#2E9D6A` | live dot, success |
| `danger` | `#E0533D` | errors, destructive, liked heart |

Gradients only one: `sky → mist` (top→bottom) behind pixel clouds. No other gradients, no heavy shadows.
Dark mode (web): bg `#0B1220`, surface `#121A2B`, ink `#EEF2F8`, navy→`#C9DBF7`, blue `#6EA4F0`, sky `#2A4A7A`,
mist `#17233A`, line `#22304A`, muted `#8C96A8`.

## Type
- Display: **Inter Tight** 700/800, tight tracking (−2% to −3%). Screen titles, game names, big numbers.
- Body/UI: **Inter** 400/500/600.
- Pixel: **Silkscreen** 400, uppercase, 10–11px, +6% tracking. Only for badges/labels (LIVE, NEW, v3,
  BUILDING, section kickers). Never for body copy or buttons.
- Scale: 34 / 28 / 22 / 17 / 15 / 13 / 11.

## Shape & depth
- Radius: 10 (chips/inputs small), 14 (inputs, buttons), 20 (cards), 28 (sheets), pill for tags.
- Borders: 1px `line`. No thick outlines.
- Shadow: one soft shadow for floating things only (sheets, FAB, toasts): `0 8px 24px rgba(13,42,102,0.10)`.
- Spacing: 4-pt grid; screen padding 16 (mobile) / 32 (web); card padding 14–16.

## Pixel motifs
- **Pixel cloud**: blocky cloud built from 4–6px squares in `sky`/`surface`, on the sky→mist gradient.
  Used in the sign-in hero, empty states, the build-in-progress card header, web hero banner.
- **Pixel sparkle**: 4-point star on a pixel grid, in `blue`. Brand mark + "new"/"done" moments.
- Pixel-font badges as above. Game thumbnails render `image-rendering: pixelated` on web.

## Layout language (game marketplace, Roblox-like)
- **Home**: avatar + wordmark + Stars pill + scan in the top bar; a search field; one **featured** banner
  (rounded xl, cover with a navy shade, name, creator, Play); then **shelves** that scroll sideways
  (Trending, From creators you follow, Most liked, Just released), each with a "See all" into Discover.
  Ends with a wash "Make your own game" card.
- **Game card**: square rounded cover (md), optional pixel badge (NEW), 2-line name, heart + play counts.
- **Discover**: big title, search, sort pills, two-column grid of game cards; top three carry a rank badge.
  Typing switches to list rows with a round blue play button.
- **Game page**: cover first, display-size name, "By @handle", full-width blue Play, a row of action tiles
  (like with count, Spin-off, Share, Edit), a wash stats strip (plays, likes, spin-offs, screen), About,
  spin-offs shelf.
- **Profile**: avatar + stats, bio, level, actions, then a two-column "Creations" grid.
- **Tabs**: Home, Discover, Create (blue square +), Shop, Me, with small labels; active = blue.

## Motion
150–220ms ease-out. Press = scale 0.97. Skeletons
shimmer in `mist`. Building state: blue ring rotates; pixel clouds drift slowly.

## Voice
Short, warm, lowercase-friendly ("your games", "building…"). No exclamation spam.
