# Dreamsy


**Quick start:** start Docker Desktop, then `./scripts/dev.sh` — runs Postgres/MinIO, migrations, the API, publishes the showcase games, the harness worker, the engine, and opens the app for Expo Go. Ctrl+C stops everything. The manual steps below are what it does.

Describe a game, play it, share it. Architecture and decisions: [DREAMSY.MD](DREAMSY.MD).

## Local dev stack (phone via Expo Go)

Everything runs on your Mac; the iPhone (Expo Go, same Wi-Fi) talks to it over the LAN.
Find the Mac's LAN IP with `ipconfig getifaddr en0` (below: `10.0.0.126`).

**One-time env**

- `services/api/.env` ← `cp services/api/.env.example services/api/.env`; set `JWT_SECRET` (32+ chars) and `WORKER_TOKEN`.
- Repo-root `.env`: model keys for the harness (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). The harness loads it itself.
- `apps/mobile/.env.local` ← `cp apps/mobile/.env.example apps/mobile/.env.local`, then:
  ```
  EXPO_PUBLIC_API_URL=http://10.0.0.126:8787
  EXPO_PUBLIC_ENGINE_URL=http://10.0.0.126:2005/
  ```
- `pnpm install` at the repo root.

**Every time** (one terminal each, from the repo root)

```sh
# 1. postgres + minio (minio-init creates the "dreamsy" bucket and exits)
docker compose -f services/api/docker-compose.yml up -d

# 2. migrate + run the API (binds 0.0.0.0:8787). The API doesn't read .env itself; export it.
(cd services/api && set -a && . ./.env && set +a && pnpm db:migrate)
(cd services/api && set -a && . ./.env && set +a && pnpm dev)

# 3. harness worker (builds games). Same WORKER_TOKEN as services/api/.env.
WORKER_TOKEN=<same as services/api/.env> pnpm -C harness worker

# 4. once, after the API is up: publish games/showcase + games/examples so Discover isn't empty
(cd services/api && set -a && . ./.env && set +a && API_URL=http://localhost:8787 pnpm seed:showcase)

# 5. engine page the app's WebView loads (Vite, 0.0.0.0:2005)
pnpm -C engine-web dev

# 6. app: Expo Go mode (expo-dev-client is installed, so plain `expo start` targets a dev build)
cd apps/mobile && npx expo start --go
```

Scan the QR code with the iPhone camera → opens in Expo Go → "Continue as guest".
Apple/Google sign-in need a development build (`npx expo run:ios`), not Expo Go.

Checks: `http://10.0.0.126:8787/health` and `http://10.0.0.126:2005/` should open in the phone's Safari.
If they don't, allow incoming connections for node in macOS Firewall.
