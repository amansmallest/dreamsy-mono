// Dev page: ?game=<path under games/> | ?zip=<url> | ?api=<base>&game=<id>&version=<n>[&token=..] | drag-drop a .zip
// Embed mode (?embed=1, or inside a react-native-webview): no dev UI; talks to the host app with JSON
// messages via window.ReactNativeWebView.postMessage:
//   {type:"ready"} | {type:"error", message} | {type:"quit"} | {type:"purchase", itemId, balance}
//   | {type:"save", key, data}   (save.set; debounced — the app may sync it to the API)
// ?clock=<unix seconds> fixes clock.now() (playtests). ?insets=top,right,bottom,left (CSS px) adds the host's safe-area insets to env(safe-area-inset-*).
import { Package, parseManifest, parseMusic, parseSfx } from "@dreamsy/format";
import { Game, GameLoadError, MemorySaveHost, saveKey, type SaveHost, type ScriptError } from "../core/index.js";
import { GameView, LocalStorageSaveHost, parseInsets, renderOffline } from "../render/index.js";
import { ApiStoreHost } from "./store.js";

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const stage = $("stage"), hud = $("hud"), consoleEl = $("console"), picker = $("picker"), message = $("message");

let view: GameView | null = null;
let game: Game | null = null;
let consoleDismissed = false;

declare global {
  interface Window { ReactNativeWebView?: { postMessage(data: string): void }; __dreamsy?: { game: Game | null; view: GameView | null; ready: boolean; error?: string; stats?: { fps: number; frameMs: number }; renderAudio?: unknown; step?: (ticks: number) => number };
    /** Set by tools before load (page.addInitScript): preloaded save data and start-scene params. */
    __dreamsyBoot?: { save?: Record<string, unknown>; sceneParams?: Record<string, unknown> } }
}
window.__dreamsy = {
  game: null, view: null, ready: false,
  /** Offline render of data/sfx or data/music JSON text (tests/tools): peak / rms / non-silent ratio. */
  renderAudio: async (kind: "sfx" | "music", json: string, seconds: number) => {
    const r = kind === "sfx" ? parseSfx(json) : parseMusic(json);
    if (!r.value || r.errors.length) throw new Error(r.errors.join("; "));
    return renderOffline(kind === "sfx" ? { sfx: r.value as any } : { music: r.value as any }, seconds);
  },
};

const embed = params.get("embed") === "1" || !!window.ReactNativeWebView || params.has("public") || /\/g\/[^/]+/.test(location.pathname);

type BridgeMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "quit" }
  | { type: "purchase"; itemId: string; balance: number | null }
  | { type: "save"; key: string; data: unknown };

function post(msg: BridgeMessage) {
  if (!embed) return;
  try { window.ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch { /* host gone */ }
}

// Errors to the host: identical messages at most every 30s, anything at most every 2s (latest wins).
const ERROR_GAP_MS = 2000, SAME_ERROR_GAP_MS = 30_000;
let lastErrorAt = 0, lastError = "", queuedError: string | null = null, errorTimer = 0;
function reportError(message: string) {
  if (!embed) return;
  message = message.slice(0, 500);
  const now = Date.now();
  if (message === lastError && now - lastErrorAt < SAME_ERROR_GAP_MS) return;
  if (now - lastErrorAt < ERROR_GAP_MS) {
    queuedError = message;
    errorTimer ||= window.setTimeout(() => {
      errorTimer = 0;
      const m = queuedError;
      queuedError = null;
      if (m) reportError(m);
    }, ERROR_GAP_MS - (now - lastErrorAt));
    return;
  }
  lastErrorAt = now;
  lastError = message;
  post({ type: "error", message });
}
if (embed) {
  window.addEventListener("error", (e) => reportError(e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) => reportError(String((e.reason as Error)?.message ?? e.reason)));
}

function showMessage(text: string) {
  message.textContent = text;
  message.style.display = "flex";
}

/** Share links: /g/<gameId> or ?public=<gameId> — plays the published version, no account needed. */
const publicId = params.get("public") ?? location.pathname.match(/\/g\/([^/?#]+)/)?.[1] ?? null;
// Hosted (play.<domain>) → api.<domain>; local dev → same host on :8787.
const defaultApi = location.hostname.startsWith("play.")
  ? `https://api.${location.hostname.slice("play.".length)}`
  : `${location.protocol}//${location.hostname}:8787`;
const publicApi = (params.get("api") ?? defaultApi).replace(/\/$/, "");

async function fetchPackage(): Promise<{ pkg: Package; label: string } | null> {
  if (publicId) {
    const res = await fetch(`${publicApi}/v1/public/games/${encodeURIComponent(publicId)}/package`);
    if (res.status === 404) throw new Error("This game isn't published (or was removed).");
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    void fetch(`${publicApi}/v1/public/games/${encodeURIComponent(publicId)}`).then((r) => r.json()).then((d: { game?: { name?: string } }) => {
      if (d.game?.name) document.title = `${d.game.name} · Dreamsy`;
    }).catch(() => {});
    return { pkg: Package.fromZip(new Uint8Array(await res.arrayBuffer())), label: publicId };
  }
  const api = params.get("api"), gameParam = params.get("game"), zip = params.get("zip");
  if (api && gameParam) {
    // GET /v1/games/:id/versions/:v/package (bearer token from ?token= or localStorage)
    const version = params.get("version") ?? "latest";
    const token = params.get("token") ?? localStorage.getItem("dreamsy_token") ?? "";
    const res = await fetch(`${api.replace(/\/$/, "")}/v1/games/${encodeURIComponent(gameParam)}/versions/${encodeURIComponent(version)}/package`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return { pkg: Package.fromZip(new Uint8Array(await res.arrayBuffer())), label: `${gameParam}@${version}` };
  }
  const url = zip ?? (gameParam ? `/__games/${gameParam}.zip` : null);
  if (!url) return null;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status} ${await res.text()}`);
  return { pkg: Package.fromZip(new Uint8Array(await res.arrayBuffer())), label: gameParam ?? url };
}

function renderConsole() {
  if (!game) return;
  const errs = game.errors;
  if (errs.length === 0 || consoleDismissed) { consoleEl.style.display = "none"; return; }
  consoleEl.style.display = "block";
  const header = `<header><span>${errs.length} script error${errs.length > 1 ? "s" : ""}</span><button id="console-close">✕</button></header>`;
  const body = errs.map((e: ScriptError) => `${esc(e.script)}${e.line ? `:${e.line}` : ""}: ${esc(e.message)}${e.count > 1 ? `  (×${e.count})` : ""}`).join("\n");
  const logs = game.logs.filter((l) => l.level === "info").slice(-5).map((l) => `<div class="log">${esc(l.text)}</div>`).join("");
  consoleEl.innerHTML = header + body + logs;
  $("console-close").onclick = () => { consoleDismissed = true; renderConsole(); };
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

async function start(pkg: Package, label: string) {
  view?.dispose();
  game?.dispose();
  view = null; game = null;
  message.style.display = "none";
  picker.style.display = "none";
  // store: the real API (Stars, purchase sheet) when ?api=&game= is set, else the free in-memory store
  const api = params.get("api"), apiGame = params.get("game");
  const items = parseManifest(pkg.text("dreamsy.toml") ?? "").manifest?.store ?? [];
  const store = api && apiGame
    ? new ApiStoreHost(api, apiGame, params.get("token") ?? localStorage.getItem("dreamsy_token") ?? "", items, stage,
        (itemId, balance) => post({ type: "purchase", itemId, balance: balance ?? null }))
    : undefined;
  const manifest = parseManifest(pkg.text("dreamsy.toml") ?? "").manifest;
  const key = manifest ? saveKey(manifest) : "dreamsy.save.unknown";
  // tools: ?save=0 (in-memory, empty) or window.__dreamsyBoot.save (in-memory, preloaded)
  const boot = window.__dreamsyBoot ?? {};
  let bootParams: Record<string, unknown> | undefined = boot.sceneParams;
  if (!bootParams && params.get("sceneParams")) { try { bootParams = JSON.parse(params.get("sceneParams")!); } catch { /* ignore */ } }
  const save: SaveHost | undefined = boot.save ? new MemorySaveHost(boot.save) : params.get("save") === "0" ? undefined : new LocalStorageSaveHost(key, (data) => post({ type: "save", key, data }));
  try {
    const fixedClock = params.has("clock") ? Number(params.get("clock")) : null;
    game = await Game.load(pkg, { store, save, clock: fixedClock !== null && Number.isFinite(fixedClock) ? () => fixedClock + (game?.time ?? 0) : undefined, seed: Number(params.get("seed") ?? 1), scene: params.get("scene") ?? undefined, sceneParams: bootParams,
      budgetMs: params.has("budget") ? Number(params.get("budget")) : undefined, onLog: (l) => (l.level === "error" ? console.error : console.log)(`[game] ${l.text}`) });
  } catch (e) {
    const msg = e instanceof GameLoadError ? e.message : `failed to start: ${(e as Error).stack ?? e}`;
    window.__dreamsy!.error = msg;
    showMessage(embed ? msg : `${label}\n\n${msg}`);
    reportError(msg);
    return;
  }
  document.title = `${game.manifest.name} — Dreamsy`;
  let errCount = -1, lastHud = 0;
  view = new GameView(stage, game, {
    touch: params.has("touch") ? params.get("touch") !== "0" : undefined,
    insets: parseInsets(params.get("insets")),
    manual: params.get("manual") === "1",
    debugShapes: params.has("debug"),
    onQuit: () => { if (embed) post({ type: "quit" }); else location.href = "./"; },
    onFrame: (s) => {
      window.__dreamsy!.stats = { fps: s.fps, frameMs: s.frameMs };
      if (embed) {
        // No HUD / console: forward new script errors to the host instead.
        const errs = game!.errors;
        if (errs.length > Math.max(errCount, 0)) {
          const e = errs[errs.length - 1]!;
          reportError(`${e.script}${e.line ? `:${e.line}` : ""}: ${e.message}`);
        }
        errCount = errs.length;
        return;
      }
      const now = performance.now();
      if (now - lastHud > 250) {
        lastHud = now;
        hud.style.display = "flex";
        hud.innerHTML = `<span>${s.fps.toFixed(0)} fps</span><span>${s.entities} ent</span><span>${game!.errors.length} err</span><a href="./">games</a><button id="restart">↻</button>`;
        $("restart").onclick = () => start(pkg, label);
      }
      if (game!.errors.length !== errCount) { errCount = game!.errors.length; renderConsole(); }
    },
  });
  await view.renderer.textures.preloadAll();
  // first frame with every texture loaded is on screen before tools start tapping
  view.renderer.render();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const v = view;
  Object.assign(window.__dreamsy!, { game, view, ready: true, step: (n: number) => v.stepTicks(n) });
  post({ type: "ready" });
}

async function showPicker() {
  picker.style.display = "block";
  let list: { path: string; name: string; dimension: string }[] = [];
  try { list = await (await fetch("/__games/index.json")).json(); } catch { /* static build */ }
  picker.innerHTML = `<h1>Dreamsy engine</h1><p>Pick a game, or drop a package .zip anywhere.</p><ul>${list
    .map((g) => `<li><a href="?game=${encodeURIComponent(g.path)}">${esc(g.name)}<small>${esc(g.path)} · ${g.dimension}</small></a></li>`)
    .join("")}</ul>`;
}

// drag & drop a zip (not in embed mode)
if (!embed) window.addEventListener("dragover", (e) => { e.preventDefault(); $("drop").style.display = "flex"; });
if (!embed) window.addEventListener("dragleave", () => ($("drop").style.display = "none"));
if (!embed) window.addEventListener("drop", async (e) => {
  e.preventDefault();
  $("drop").style.display = "none";
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  try { await start(Package.fromZip(new Uint8Array(await f.arrayBuffer())), f.name); } catch (err) { showMessage(String(err)); }
});

(async () => {
  try {
    const loaded = await fetchPackage();
    if (loaded) await start(loaded.pkg, loaded.label);
    else if (embed) { showMessage("No game to load."); reportError("no game to load (missing ?game=)"); }
    else await showPicker();
  } catch (e) {
    window.__dreamsy!.error = String(e);
    const msg = String((e as Error).message ?? e);
    showMessage(embed ? "Couldn't load this game." : msg);
    reportError(msg);
  }
})();
