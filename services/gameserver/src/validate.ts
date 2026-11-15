// Client message validation: shape + bounds. Anything else is "bad_message".
import { LIMITS, type AvatarState, type ClientMsg } from "@dreamsy/engine/net";

const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const GAME_RE = /^[A-Za-z0-9_.:/@-]{1,128}$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitizeName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, LIMITS.nameLength);
}

function avatarState(s: unknown): s is AvatarState {
  return Array.isArray(s) && s.length === 8 && isStr(s[0], 128) && isNum(s[1]) && isNum(s[2]) && isNum(s[3])
    && (s[4] === 0 || s[4] === 1) && isStr(s[5], 64) && (s[6] === 0 || s[6] === 1) && isStr(s[7], 128);
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "hello": return isStr(o.token, 4096, 1) && (o.name === undefined || typeof o.name === "string") ? { t: "hello", token: o.token, name: o.name as string | undefined } : null;
    case "create":
      if (!isStr(o.game, 128) || !GAME_RE.test(o.game) || !isNum(o.max)) return null;
      if (o.min !== undefined && !isNum(o.min)) return null;
      if (o.mode !== undefined && o.mode !== "duel" && o.mode !== "party") return null;
      return { t: "create", game: o.game, max: o.max, min: o.min as number | undefined, mode: o.mode as "duel" | "party" | undefined };
    case "join": return isStr(o.code, 16, 1) && (o.game === undefined || (isStr(o.game, 128) && GAME_RE.test(o.game))) ? { t: "join", code: o.code, game: o.game as string | undefined } : null;
    case "quick": return isStr(o.game, 128) && GAME_RE.test(o.game) ? { t: "quick", game: o.game } : null;
    case "cancel": case "start": case "leave": return { t: o.t };
    case "ready": return typeof o.v === "boolean" ? { t: "ready", v: o.v } : null;
    case "team": return o.team === "red" || o.team === "blue" ? { t: "team", team: o.team } : null;
    case "ping": return isNum(o.c) ? { t: "ping", c: o.c } : null;
    case "st": return avatarState(o.s) ? { t: "st", s: o.s } : null;
    case "ev": return isStr(o.n, 64) && NAME_RE.test(o.n) && isStr(o.to, 64, 1) && Array.isArray(o.a) ? { t: "ev", n: o.n, to: o.to, a: o.a } : null;
    case "kv": return isStr(o.k, 64) && NAME_RE.test(o.k) && "v" in o ? { t: "kv", k: o.k, v: o.v } : null;
    case "score": return isStr(o.k, 64, 1) && isNum(o.d) && Math.abs(o.d) <= 1e6 ? { t: "score", k: o.k, d: o.d } : null;
    case "end": return o.w === null || isStr(o.w, 64, 1) ? { t: "end", w: o.w as string | null } : null;
  }
  return null;
}
