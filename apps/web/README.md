# apps/web — Dreamsy Studio (`app.dreamsy.app`)

Browser dashboard for creators: build and edit games by chat, watch builds live, redraw sprites,
publish. **No playing here** — "Play on phone" opens the mobile app via QR / deep link.

Vite + React 19 + TypeScript + React Router · plain CSS (`src/styles/app.css`, tokens match
`apps/mobile/src/theme.ts`) · `@supabase/supabase-js` · `qrcode.react`. Charts are hand-rolled SVG.

## Run

```sh
cp .env.example .env.local     # fill in
pnpm -C apps/web dev           # http://localhost:3000
pnpm -C apps/web build         # typecheck + dist/
```

| Env | |
|---|---|
| `VITE_API_URL` | services/api (default `http://localhost:8787`) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | same Supabase project as the app. Unset URL ⇒ dev-only "Continue as guest" |
| `VITE_APP_DEEPLINK` | QR target base, `${base}/game/<id>` (default `dreamsy://`) |
| `VITE_SHARE_URL` | public share page base, `${base}/g/<id>` (default `https://dreamsy.app`) |

Supabase redirect URLs: `http://localhost:3000/**`, `https://app.dreamsy.app/**` (Google OAuth returns
to the current origin; email OTP accepts the 6-digit code or the magic link).

## Auth

Supabase session → `POST /v1/auth/supabase {accessToken}` → Dreamsy `{user, token}`; that token is the
bearer for every call. Re-exchanged on `SIGNED_IN` / `TOKEN_REFRESHED`; a 401 refreshes + re-exchanges
once, then signs out. Guest mode stores the guest token in localStorage.

## Screens

- `/` — my games (thumbnail, Draft/Live, version, live build badge with round/ETA), New game → name +
  first prompt + reference images → workspace.
- `/games/:id` — workspace: preview (version switcher, publish/update/unpublish, Play on phone QR),
  build chat (composer with image attach + quick chips, ⌘↵; each generation's SSE timeline with
  Last-Event-ID resume, progress card with local ETA countdown, cancel), Sprites (gallery by version,
  kind filter + search, click-to-edit drawer with provenance prompt + chips → `POST generations
  {prompt, assetIds}`, multi-select, inline live progress, before/after toggle) and Versions (restore).
- `/activity` — builds across games (`/v1/me/activity`), filter, expandable timelines.
- `/insights` — Earnings (`/v1/me/earnings`: totals, today, paid plays, per-game table + bars; hidden on 404), then `/v1/me/insights` vs `/v1/insights/engine`: art score, success rate, memory hits,
  cost, minutes, sprite reuse, by-kit.
- `/account` — handle/bio, quota, coins wallet + ledger + earnings line, sign out. Light/dark toggle in the top bar.

## Screenshots (mocked API)

```sh
S=/tmp/dreamsy-web
VITE_SUPABASE_URL= VITE_API_URL=http://mock.api npx vite build --outDir $S/dist
node scripts/screenshots.mjs $S/dist $S/shots     # vite preview + Playwright route mocks (scripts/mock-api.mjs)
```
