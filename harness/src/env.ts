import { existsSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node tries IPv6 and IPv4 in parallel with a 250ms per-attempt window. On networks with broken IPv6
// and a slow IPv4 handshake (VPNs, venue Wi-Fi) every attempt times out → "Connection error".
// A longer window costs nothing on good networks.
setDefaultAutoSelectFamilyAttemptTimeout(2000);
import { fileURLToPath } from "node:url";

/** Loads the repo-root .env (then harness/.env) without overriding real env vars. */
export function loadEnv() {
  for (const rel of ["../../.env", "../.env", "../../services/api/.env"]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) {
      try { process.loadEnvFile(path); } catch { /* malformed .env: ignore, fall back to process env */ }
    }
  }
}

export function anthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
}

export function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GEMINI || process.env.GEMINI_API_KEYS?.split(",")[0]?.trim();
}
