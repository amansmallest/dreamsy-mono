// Prints the TypeScript validator's verdict for each package directory as one JSON line:
//   {"dir": "...", "ok": true, "issues": [{"severity", "code", "file", "id"}...]}
// Used by conformance.py to compare format/src/validate.ts with the C++ engine's loader.
// Run from format/ so its dependencies resolve:  npx tsx ../engine/tests/conformance/ts_validate.mts <dir>...
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Package, registerKitDependencies, validatePackage } from "../../../format/src/index.ts";

// Same kit dependency registration as format/src/cli.ts.
const kitsDir = fileURLToPath(new URL("../../../engine-web/kits/", import.meta.url));
const deps: Record<string, string[]> = {};
for (const k of readdirSync(kitsDir)) {
  const f = `${kitsDir}${k}/kit.json`;
  if (existsSync(f)) deps[k] = JSON.parse(readFileSync(f, "utf8")).requires ?? [];
}
registerKitDependencies(deps);

for (const dir of process.argv.slice(2)) {
  try {
    const r = validatePackage(await Package.fromDir(dir));
    const issues = r.issues.map((i) => ({ severity: i.severity, code: i.code, file: i.file ?? "", id: i.id ?? "", message: i.message }));
    console.log(JSON.stringify({ dir, ok: r.ok, issues }));
  } catch (e) {
    console.log(JSON.stringify({ dir, ok: false, crash: String(e), issues: [] }));
  }
}
