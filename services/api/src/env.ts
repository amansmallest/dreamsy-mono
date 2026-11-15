import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load services/api/.env, then the repo-root .env, without overriding real env vars.
for (const rel of ["../.env", "../../../.env"]) {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* ignore malformed */ }
  }
}
