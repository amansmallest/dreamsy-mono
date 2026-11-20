import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkg, "..", "..");
const data = join(pkg, "data");

rmSync(join(pkg, "dist"), { recursive: true, force: true });
rmSync(data, { recursive: true, force: true });

const result = await build({
  metafile: true,
  entryPoints: [join(repo, "harness/src/mcp/server.ts")],
  outdir: join(pkg, "dist"),
  entryNames: "server",
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { playwright: "playwright-core" },
  external: ["playwright-core"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});

const skip = new Set(["node_modules", "_tools", ".DS_Store"]);
const copy = (from, to) => cpSync(join(repo, from), join(data, to ?? from), { recursive: true, filter: (src) => !src.split("/").some((p) => skip.has(p)) });

copy("kits");
copy("taste");
copy("format/LUAU_API.md");
for (const d of readdirSync(join(repo, "games/examples"))) if (d.startsWith("kit-")) copy(`games/examples/${d}`);

const web = join(repo, "engine/build/web");
if (existsSync(join(web, "dreamsy-player.wasm"))) {
  mkdirSync(join(data, "engine/build/web"), { recursive: true });
  for (const f of ["dreamsy-player.html", "dreamsy-player.js", "dreamsy-player.wasm"]) cpSync(join(web, f), join(data, "engine/build/web", f));
  if (existsSync(join(web, "kits"))) cpSync(join(web, "kits"), join(data, "engine/build/web/kits"), { recursive: true, filter: (src) => !src.includes(".DS_Store") });
}

const native = join(pkg, "native");
rmSync(native, { recursive: true, force: true });
const binaries = {
  "darwin-arm64": join(repo, "engine/build/npm-darwin-arm64/dreamsy-tool"),
  "darwin-x64": join(repo, "engine/build/npm-darwin-x64/dreamsy-tool"),
  "linux-x64": join(pkg, "prebuilt/linux-x64/dreamsy-tool"),
  "linux-arm64": join(pkg, "prebuilt/linux-arm64/dreamsy-tool"),
};
for (const [plat, src] of Object.entries(binaries)) {
  if (!existsSync(src)) {
    console.warn(`missing engine binary for ${plat}: ${src}`);
    continue;
  }
  const out = join(native, plat, "dreamsy-tool");
  mkdirSync(dirname(out), { recursive: true });
  cpSync(src, out);
  chmodSync(out, 0o755);
  if (plat.startsWith("darwin")) execFileSync("strip", ["-x", out]);
}
console.log("built dist/server.mjs and data/");

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|ofl)(\.(md|txt))?$/i;
const licensesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).map((f) => join(dir, f)) : []);
const section = (title, files) => `=== ${title} ===\n\n${files.map((f) => readFileSync(f, "utf8").trim()).join("\n\n")}\n`;

function engineNotices() {
  const out = [];
  for (const lib of readdirSync(join(repo, "third_party")).sort()) {
    const dir = join(repo, "third_party", lib);
    if (!statSync(dir).isDirectory()) continue;
    const files = licensesIn(dir);
    for (const sub of readdirSync(dir)) {
      const subdir = join(dir, sub);
      if (statSync(subdir).isDirectory()) files.push(...licensesIn(subdir));
    }
    if (files.length) out.push(section(`third_party/${lib} (compiled into the Dreamsy engine)`, files));
  }
  return out;
}

const jsPackages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = resolve(process.cwd(), input);
  const m = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(abs);
  if (m && !jsPackages.has(m[2])) jsPackages.set(m[2], m[1]);
}
const jsNotices = [...jsPackages].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, dir]) => {
  const files = licensesIn(dir);
  let version = "";
  try { version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch {}
  return files.length ? [section(`${name}${version ? ` ${version}` : ""} (bundled in dist/)`, files)] : [];
});

const header = "Third-party software included in this package and its licenses.\nDreamsy's own code is under the PolyForm Noncommercial License 1.0.0 (see LICENSE).\n\n";
const engine = engineNotices();
writeFileSync(join(pkg, "THIRD-PARTY-NOTICES.txt"), header + [...jsNotices, ...engine].join("\n"));
cpSync(join(repo, "LICENSE"), join(pkg, "LICENSE"));
console.log(`notices: ${jsNotices.length} bundled JS packages, ${engine.length} engine libraries`);
