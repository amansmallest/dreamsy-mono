# Dreamsy cloud

A Cloudflare Worker that saves and publishes games without accounts. R2 (`dreamsy-games`) holds packages, stored once
per content hash (`packs/<sha256>.dpk`), and thumbnails; D1 (`dreamsy`) holds the index.

- **Save key:** each browser makes a random key and sends it as `Authorization: Bearer <key>`. The Worker stores
  only `sha256` of it as the owner id. No accounts, no personal data.
- **Publish:** `POST /v1/games/:id/publish { author, link, email, remix }` gives a public slug. Author and link are
  public; the email stays private (owner-only). The web player plays published games with `?api=<worker>&public=<slug>`.

| Route | Who | What |
|---|---|---|
| `GET/POST /v1/games` | owner | list / create games |
| `GET/PATCH/DELETE /v1/games/:id` | owner | game, versions, publication; rename; delete |
| `POST /v1/games/:id/versions` | owner | upload a `.dpk` (header `x-dreamsy-label`), returns the version |
| `GET /v1/games/:id/versions/:v/package` | owner | download a version |
| `PUT /v1/games/:id/versions/:v/thumb` | owner | JPEG/PNG/WebP thumbnail |
| `POST/DELETE /v1/games/:id/publish` | owner | publish or unpublish |
| `GET /v1/thumbs/:id` | anyone with the id | latest thumbnail |
| `GET /v1/public/games[/:slug[/package\|/thumb]]` | public | recent games, one game, its package |
| `POST /v1/public/games/:slug/{play,report,remix}` | public / owner | count a play, report, remix into your games |

```sh
pnpm -C services/cloud test            # Miniflare: real local R2 + D1, no server
pnpm -C services/cloud dev             # local Worker on 127.0.0.1:8788
pnpm -C services/cloud migrate:remote  # apply migrations/ to the real D1
pnpm -C services/cloud deploy
```

Set `ALLOWED_ORIGINS` in `wrangler.toml` to the site's origins before deploying.
