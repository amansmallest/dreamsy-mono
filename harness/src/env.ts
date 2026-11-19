import { existsSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

setDefaultAutoSelectFamilyAttemptTimeout(2000);
import { repoPath } from "./paths.js";

export function loadEnv() {
  for (const rel of [".env", "harness/.env", "services/api/.env"]) {
    const path = repoPath(rel);
    if (existsSync(path)) {
      try { process.loadEnvFile(path); } catch {}
    }
  }
}

export function anthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY;
}

export function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GEMINI || process.env.GEMINI_API_KEYS?.split(",")[0]?.trim();
}
