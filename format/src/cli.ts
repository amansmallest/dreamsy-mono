#!/usr/bin/env -S npx tsx
import { readFile, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { CATALOG } from "./catalog.js";
import { applyOps, OpError, parseOps } from "./ops.js";
import { Package } from "./package.js";
import { PackError } from "./pack.js";
import { STYLES } from "./styles.js";
import { validatePackage } from "./validate.js";
import { registerKitDependencies } from "./kits.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Shipped kit dependencies (engine-web/kits/<kit>/kit.json) when run inside the monorepo.
try {
  const kitsDir = fileURLToPath(new URL("../../engine-web/kits/", import.meta.url));
  if (existsSync(kitsDir)) {
    const deps: Record<string, string[]> = {};
    for (const k of readdirSync(kitsDir)) {
      const f = `${kitsDir}${k}/kit.json`;
      if (existsSync(f)) { try { deps[k] = JSON.parse(readFileSync(f, "utf8")).requires ?? []; } catch { /* ignore */ } }
    }
    registerKitDependencies(deps);
  }
} catch { /* not in the monorepo */ }

const USAGE = `dreamsy-format <command>
  validate <dir|zip|dpk>             static validation; exit 1 on errors
  pack <dir|zip|dpk> <out>           validate + write a Dreamsy pack (.dpk) or a deterministic zip
  unpack <zip|dpk> <dir>             extract
  apply <dir|zip|dpk> <ops.json> <out>  apply an op batch, validate, write dir, .dpk or .zip
  catalog                            print entity types + styles as JSON (for engine/harness)`;

async function load(path: string): Promise<Package> {
  if ((await stat(path)).isDirectory()) return Package.fromDir(path);
  const bytes = new Uint8Array(await readFile(path));
  return path.endsWith(".dpk") ? Package.fromPack(bytes) : Package.fromZip(bytes);
}

function report(pkg: Package): boolean {
  const r = validatePackage(pkg);
  for (const i of r.issues) {
    console.error(`${i.severity === "error" ? "✗" : "!"} [${i.code}] ${i.file ?? ""}${i.id ? ` #${i.id}` : ""}: ${i.message}`);
  }
  const errors = r.issues.filter((i) => i.severity === "error").length;
  console.error(r.ok ? `✓ valid (${r.issues.length} warnings)` : `✗ ${errors} errors`);
  return r.ok;
}

async function write(pkg: Package, out: string) {
  if (out.endsWith(".dpk")) await writeFile(out, pkg.toPack());
  else if (out.endsWith(".zip")) await writeFile(out, pkg.toZip());
  else await pkg.toDir(out);
}

const [cmd, ...args] = process.argv.slice(2);
try {
switch (cmd) {
  case "validate":
    process.exit(report(await load(args[0]!)) ? 0 : 1);
  case "pack": {
    const pkg = await load(args[0]!);
    if (!report(pkg)) process.exit(1);
    const out = args[1]!;
    await writeFile(out, out.endsWith(".dpk") ? pkg.toPack() : pkg.toZip());
    if (out.endsWith(".dpk")) console.error(`content hash ${pkg.contentHash()}`);
    break;
  }
  case "unpack":
    await (await load(args[0]!)).toDir(args[1]!);
    break;
  case "apply": {
    try {
      const ops = parseOps(JSON.parse(await readFile(args[1]!, "utf8")));
      const next = applyOps(await load(args[0]!), ops);
      const ok = report(next);
      await write(next, args[2]!);
      process.exit(ok ? 0 : 1);
    } catch (e) {
      if (e instanceof OpError) { console.error(`✗ ${e.message}`); process.exit(1); }
      throw e;
    }
  }
  case "catalog":
    console.log(JSON.stringify({ entities: CATALOG, styles: STYLES }, null, 2));
    break;
  default:
    console.error(USAGE);
    process.exit(cmd ? 1 : 0);
}
} catch (e) {
  if (e instanceof PackError) { console.error(`✗ ${e.message}`); process.exit(1); }
  throw e;
}
