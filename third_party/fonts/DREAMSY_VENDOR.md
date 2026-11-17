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

Characters outside the subset render as the font's missing glyph. Wider scripts (CJK, Arabic, emoji) are a
later font-fallback item (DREAMSY.MD §14.12).
