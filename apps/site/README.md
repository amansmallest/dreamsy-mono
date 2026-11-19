# Dreamsy site

The public website and the game editor (Next.js).

```sh
pnpm -C apps/site dev        # http://127.0.0.1:3100
```

- `/`, `/library`, `/kits`, `/docs`: the marketing site.
- `/editor`: make and edit games. Builds run the harness on this machine (`harness/src/cli/editor.ts`) with the API key
  you add in the editor, which is kept in an httpOnly cookie and never saved to disk. Games are folders in
  `games/mine` (set `DREAMSY_GAMES_DIR` to change it). Needs `engine/build/release/dreamsy-tool`; the preview also needs
  the web player (`engine/build/web`). See docs/harness.md §5.5.

## Deploying

Set `SITE_URL` (for example `https://dreamsy.example`) so canonical links, Open Graph images, `robots.txt` and
`sitemap.xml` use the real domain; it falls back to `http://127.0.0.1:3100`. Regenerate the OG image and app icons
with `pnpm -C apps/site brand` after changing the logo (`components/Logo.tsx`) or the headline.

## Cloud save

Set `DREAMSY_CLOUD_URL` (the deployed `services/cloud` Worker) and every successful editor build is also uploaded to the
cloud, under a save key the server creates per browser (httpOnly cookie `dreamsy_save`). Without it, games stay only in
`games/mine`. The harness `local` command does the same with `DREAMSY_CLOUD_URL` + `DREAMSY_SAVE_KEY`.
