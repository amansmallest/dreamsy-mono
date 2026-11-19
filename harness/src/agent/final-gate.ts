import { type Package, validatePackage } from "@dreamsy/format";
import { SMOKE_TIMELINE, type Playtester } from "../engine/playtest.js";
import { fmtIssue } from "./workspace.js";

export async function finalGate(pkg: Package, playtest: Playtester): Promise<{ ok: boolean; errors: string[] }> {
  const r = validatePackage(pkg);
  const errors = r.issues.filter((i) => i.severity === "error").map(fmtIssue);
  if (!r.manifest) errors.push("- dreamsy.toml is missing or invalid");
  if (errors.length || r.manifest?.dimension !== "2d") return { ok: errors.length === 0, errors };

  const run = await playtest.simulate(pkg, SMOKE_TIMELINE, 8);
  if (run.loadError) errors.push(`- Game failed to boot in the engine: ${run.loadError}`);
  for (const e of run.errors.slice(0, 15)) {
    errors.push(`- Runtime error during an 8s smoke run (move/jump/action): ${e.script}${e.line ? `:${e.line}` : ""} ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`);
  }
  return { ok: errors.length === 0, errors };
}
