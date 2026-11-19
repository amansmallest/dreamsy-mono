#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.DREAMSY_ROOT ??= join(here, "..", "data");

if (!process.env.DREAMSY_TOOL) {
  const pkg = `dreamsy-mcp-${process.platform}-${process.arch}`;
  let tool = null;
  try {
    tool = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", process.platform === "win32" ? "dreamsy-tool.exe" : "dreamsy-tool");
  } catch {}
  if (!tool || !existsSync(tool)) {
    process.stderr.write(
      `dreamsy-mcp: no engine binary for ${process.platform}-${process.arch} yet (looked for ${pkg}).\n` +
        "Build it from source (https://github.com/apoorvcodes/dreamsy-mono, engine/README.md) and set DREAMSY_TOOL to its path.\n",
    );
    process.exit(1);
  }
  process.env.DREAMSY_TOOL = tool;
}

if (process.env.PLAYTEST_BROWSER === undefined) {
  try {
    await import("playwright");
  } catch {
    process.env.PLAYTEST_BROWSER = "0";
  }
}

await import("../dist/server.mjs");
