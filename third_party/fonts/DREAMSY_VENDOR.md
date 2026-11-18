# Vendored fonts (engine default fonts)

The four theme fonts of engine-web (`engine-web/core/theme.ts` FONT_STACKS: pixel, rounded, bold, serif),
bundled so text looks the same on every platform without system fonts. Embedded into the player by
`engine/cmake/embed_fonts.cmake`; loaded by `engine/src/render/font.cpp`. All SIL Open Font License 1.1
(each folder has its OFL.txt).

Upstream: google/fonts main @ `7af0d90b4d532ffa4b041937b560c6df4e7b1e95`

| Theme font | Folder / file | Upstream file | Modified? |
|---|---|---|---|
| pixel | `press-start-2p/PressStart2P-Regular.ttf` | `ofl/pressstart2p/PressStart2P-Regular.ttf` | no (has a Reserved Font Name, so it must stay unmodified) |
| rounded | `nunito/Nunito-ExtraBold-Latin1.ttf` | `ofl/nunito/Nunito[wght].ttf` | yes: instanced + subset (no Reserved Font Name) |
| bold | `inter/Inter-Bold-Latin1.ttf` | `ofl/inter/Inter[opsz,wght].ttf` | yes: instanced + subset (no Reserved Font Name) |
| serif | `source-serif-4/SourceSerif4-Bold-Latin1.ttf` | `ofl/sourceserif4/SourceSerif4[opsz,wght].ttf` | yes: instanced + subset (no Reserved Font Name) |

Why modified: stb_truetype reads only a variable font's default instance, and the full files are 0.3-1.2 MB each
(the web build budget is 1.5 MB gzipped, DREAMSY.MD §14). The three derived files are static bold instances
subset to Latin-1 plus common punctuation (~16-21 KB gzipped each). Made with fontTools 4.57.0:

```sh
U="U+0020-007E,U+00A0-00FF,U+0152-0153,U+2013-2014,U+2018-201E,U+2022,U+2026,U+20AC,U+2122,U+2190-2193"
python -m fontTools.varLib.instancer Nunito[wght].ttf wght=800 -o nunito_i.ttf
python -m fontTools.varLib.instancer Inter[opsz,wght].ttf wght=700 opsz=14 -o inter_i.ttf
python -m fontTools.varLib.instancer SourceSerif4[opsz,wght].ttf wght=700 opsz=20 -o serif_i.ttf
python -m fontTools.subset <x>_i.ttf --unicodes="$U" --layout-features='kern,liga' --no-hinting \
  --desubroutinize --output-file=<out>.ttf
```

Characters outside the subset fall back to the DejaVu symbol font (below), else render as the missing glyph. Wider scripts (CJK, Arabic, emoji) are a
later font-fallback item (DREAMSY.MD §14.12).

## DejaVu (pixel theme font, symbol fallback) — added in E6

Bitstream Vera license + public-domain DejaVu changes (`dejavu/LICENSE`): permissive, modified copies allowed as
long as they aren't named "Bitstream" or "Vera".

Upstream: dejavu-fonts/dejavu-fonts release `version_2_37`, `dejavu-fonts-ttf-2.37.tar.bz2`
(sha256 `fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7`).

| Use | File | Upstream file | Modified? |
|---|---|---|---|
| pixel theme font | `dejavu/DejaVuSansMono-Bold-Latin1.ttf` | `ttf/DejaVuSansMono-Bold.ttf` | yes: subset to the Latin-1 set above |
| symbol fallback (any font) | `dejavu/DejaVuSans-Bold-Symbols.ttf` | `ttf/DejaVuSans-Bold.ttf` | yes: subset to symbol ranges |

Why: engine-web's pixel stack (`"Press Start 2P", "Silkscreen", "VT323", ui-monospace, ...`) names fonts no phone
or browser has, so every shipped game was laid out with the bold system monospace (SF Mono / Menlo), 0.6 em per
character. Press Start 2P is 1 em per character, so text overflowed its panels in the C++ engine. DejaVu Sans Mono
Bold has Menlo's exact metrics (Menlo is derived from it). Press Start 2P stays in `press-start-2p/` but is no
longer embedded.

The symbol font covers characters games use outside Latin-1 (▶ ▼ ▲ ★ ♥ ⚔ ✓ → ≥ …): Greek letters, punctuation,
currency, arrows, a few math operators, geometric shapes, misc symbols, dingbats. Every bundled font falls back
to it for a character it lacks (`engine/src/render/font.cpp`). Made with fontTools 4.57.0:

```sh
python -m fontTools.subset DejaVuSansMono-Bold.ttf --unicodes="$U" --layout-features='kern,liga' --no-hinting \
  --desubroutinize --output-file=DejaVuSansMono-Bold-Latin1.ttf
S="U+0391-03C9,U+2010-205E,U+20A0-20BF,U+2116,U+2122,U+2190-21FF,U+2211,U+2212,U+2215,U+221A,U+221E,U+2248,\
U+2260,U+2264,U+2265,U+2302,U+2318,U+231A-231B,U+23E9-23FA,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+2B05-2B07,\
U+2B1B-2B1C,U+2B50,U+2B55"
python -m fontTools.subset DejaVuSans-Bold.ttf --unicodes="$S" --layout-features='' --no-hinting \
  --desubroutinize --output-file=DejaVuSans-Bold-Symbols.ttf
```
