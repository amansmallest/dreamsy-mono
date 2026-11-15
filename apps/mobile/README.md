# apps/mobile — Dreamsy app (iOS first)

Create (chat + live preview) and play. Expo + expo-router + TypeScript. See DREAMSY.MD §6.

## Setup

```sh
pnpm install                       # from the repo root
cp apps/mobile/.env.example apps/mobile/.env.local   # fill in the values
```

Native projects are generated (Continuous Native Generation). `ios/` and `android/` are
gitignored; never edit them by hand — change `app.config.ts` or a config plugin instead.

```sh
cd apps/mobile
npx expo run:ios                   # prebuild + build the dev client + install on simulator/device
npx expo start --dev-client        # JS server for an already-installed dev client
```

**Expo Go** works for everything except Apple/Google sign-in: `npx expo start --go` (or
`pnpm start:go`), scan the QR code, "Continue as guest". In Expo Go (`src/runtime.ts` `isExpoGo`)
the Google SDK is never required and the Apple/Google buttons are hidden (Apple tokens from Expo Go
carry Expo Go's audience, which the API rejects). Full stack steps: repo-root `README.md`.

Sign in with Apple and Google Sign-In need a dev-client build (`expo-dev-client`). Sign in with
Apple only fully works on a real device signed with a team that has the capability enabled.

Rerun `npx expo prebuild --clean` after changing `app.config.ts`, env vars it reads, or
native dependencies.

## Env

| Var | Used by | What |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | JS | `services/api` base URL (LAN IP on device) |
| `EXPO_PUBLIC_ENGINE_URL` | JS | engine-web page the player WebView loads (LAN IP, `:2005/`) |
| `EXPO_PUBLIC_WEB_URL` | JS | optional public web base for share links (`<base>/g/<id>`); falls back to the engine URL. Built in `src/social.ts` `shareUrl()` |
| `DREAMSY_IOS_BUNDLE_ID` | app.config | iOS bundle id |
| `DREAMSY_ANDROID_PACKAGE` | app.config | Android package (later) |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | JS | Google iOS OAuth client id |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | JS | Google web OAuth client id = idToken audience the API verifies |
| `GOOGLE_IOS_URL_SCHEME` | app.config | reversed iOS client id (`com.googleusercontent.apps.…`) |

## Layout

```
app/                 expo-router routes
  _layout.tsx        AuthProvider + protected stack (signed in -> tabs, else sign-in)
  sign-in.tsx        email code (default) / Google / Apple / guest
  onboarding.tsx     first run: handle + avatar
  avatar.tsx         edit avatar (modal)
  (tabs)/            Home (feed tabs + search), Create (my games, running builds + ETA),
                     Market (store items across games), Profile (own profile, Stars wallet)
  discover/[id].tsx  game page: play, like, share, share with family, remix, creator, report (DREAMSY.MD §11);
                     leaderboards (board picker, Everyone / each of my groups, top 20, me, ghost badge; §13)
  user/[id].tsx      creator profile: follow, published games
  groups/index.tsx   Family & friends (DREAMSY.MD §13): my groups, start one (share sheet with the invite link),
                     join by code. Reached from Profile (row + menu) and the people icon on Home
  groups/[id].tsx    group: invite code + share, members, shared games (Play; drafts too), leave, delete /
                     new code (owner)
  join/[code].tsx    invite link dreamsy://join/<code> or https://dreamsy.dev/join/<code> (also from the QR
                     scanner). Joins when signed in; otherwise the code waits until sign-in + onboarding
  game/[id].tsx      Create workspace: chat + preview, publish, round/ETA card, checkpoint reloads
  play/[id].tsx      full-screen player (params id, version, orientation?); locks to the game's
                     orientation and passes safe-area insets to the engine (`&insets=t,r,b,l`)
src/
  api.ts             typed client for services/api; takes its bearer token from auth
  runtime.ts         isExpoGo
  social.ts          shareUrl/shareGame, number formatting, fallback gradients
  usePaged.ts        cursor pagination for feeds/search/market
  wallet.ts          useWallet() + walletChanged() (refetch after in-game purchases)
  components/
    EngineView.tsx   the game player: WebView of engine-web in embed mode + message bridge
    GamePreview.tsx  inline 16:10 player card (workspace, discover detail)
  auth/              ALL auth logic; screens import only from '@/auth'
    index.ts         public surface: AuthProvider, useAuth, SignInCancelled
    AuthProvider.tsx context: signInWithApple/Google, continueAsGuest, signOut, getAccessToken
    native.ts        Apple + Google native SDKs -> identityToken / idToken (backend-agnostic)
    types.ts         AuthBackend interface (the swappable part)
    dreamsyApiBackend.ts  current backend: services/api /v1/auth/*, token in expo-secure-store
modules/
  dreamsy-engine/    notes on the player bridge (see its README)
```

## Auth flow

Screens use `useAuth()` from `@/auth` only.

1. **Email code** (default, `src/auth/dreamsyApiBackend.ts`): `POST /v1/auth/email/start {email}` emails a
   6-digit code (expires in 10 min; resend after 30 s), `POST /v1/auth/email/verify {email, code}` returns
   `{ user, token }`. No Supabase involved. Typing a username without `@` uses the demo bypass
   (`/v1/auth/demo`, usernames ending in `_demo`).
   **Google** (`src/auth/supabase.ts`, hidden unless the Supabase env vars are set): Supabase OAuth (PKCE) in the system auth sheet, redirecting
   to `dreamsy://auth-callback` (`exp://…/--/auth-callback` in Expo Go, so it works there too). The
   Supabase access token goes to `POST /v1/auth/supabase`, which verifies it against the project's
   JWKS and returns `{ user, token }`. **Apple**: native sheet -> `/v1/auth/apple` (dev builds only).
   **Guest**: `/v1/auth/guest`.
2. The Dreamsy token goes to the keychain (`expo-secure-store`). On launch `/v1/me` restores the
   session; a 401 signs out.
3. Signed in with `user.avatar == null` -> `app/onboarding.tsx` (handle, then avatar maker). Saving
   the avatar (`PATCH /v1/me {avatar}`) lands in the tabs.

## Design

Ink on paper (`src/theme.ts`): cream `#F3EFE6`, ink `#141414`, 2px outlines, Silkscreen pixel caps for
labels/buttons and Space Grotesk for text. Build screens from `src/ui` (Txt, InkButton, RoundButton,
Card, Header, Pills, ProgressBar, Field, Empty). Avatars are SVG busts from parts (`src/avatar`),
stored as `{ hat, head, eyes, mouth, extra, body }` indices; users without one get a stable avatar from their id.

## Engine view

`src/components/EngineView.tsx` renders a WebView of
`${EXPO_PUBLIC_ENGINE_URL}?api=${EXPO_PUBLIC_API_URL}&game=<id>&version=<n>&token=<jwt>&embed=1`.
The page (`engine-web/dev/main.ts`) downloads the package from the API, hides its dev UI in embed
mode, and posts JSON back via `window.ReactNativeWebView.postMessage`:

| message | app does |
|---|---|
| `{type:"ready"}` | hide the spinner |
| `{type:"error", message}` | banner (load errors + script errors, rate-limited) |
| `{type:"quit"}` | pause-menu Quit: closes the Play screen |
| `{type:"purchase", itemId, balance}` | Stars purchase in the engine's sheet: wallet refetch |

The workspace preview is keyed by `latestVersion`, so a finished generation (or a restore)
reloads it. Production will point `EXPO_PUBLIC_ENGINE_URL` at a hosted build of the engine page.
