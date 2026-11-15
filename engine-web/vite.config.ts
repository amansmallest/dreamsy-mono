import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { defineConfig, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "..");
const gamesDir = join(repo, "games");

/** Lists packages under games/ (any dir with a dreamsy.toml), and serves each as a zip. */
function listPackages(): { path: string; name: string; dimension: string }[] {
  const out: { path: string; name: string; dimension: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    if (existsSync(join(dir, "dreamsy.toml"))) {
      const toml = readFileSync(join(dir, "dreamsy.toml"), "utf8");
      out.push({
        path: relative(gamesDir, dir).split("\\").join("/"),
        name: /^name\s*=\s*"([^"]*)"/m.exec(toml)?.[1] ?? dir,
        dimension: /^dimension\s*=\s*"([^"]*)"/m.exec(toml)?.[1] ?? "?",
      });
      return;
    }
    for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules") walk(join(dir, d.name), depth + 1);
  };
  walk(gamesDir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function zipDir(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name !== ".DS_Store") files[relative(dir, abs).split("\\").join("/")] = new Uint8Array(readFileSync(abs));
    }
  };
  walk(dir);
  return zipSync(files, { level: 0 });
}

function gamesPlugin(): Plugin {
  return {
    name: "dreamsy-games",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]!);
        if (url === "/__games/index.json") {
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(listPackages()));
          return;
        }
        const m = /^\/__games\/(.+)\.zip$/.exec(url);
        if (m) {
          const dir = resolve(gamesDir, m[1]!);
          if (!dir.startsWith(gamesDir) || !existsSync(join(dir, "dreamsy.toml")) || !statSync(dir).isDirectory()) {
            res.statusCode = 404;
            res.end("no such package");
            return;
          }
          res.setHeader("content-type", "application/zip");
          res.setHeader("cache-control", "no-store");
          res.end(Buffer.from(zipDir(dir)));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: join(here, "dev"),
  base: "./",
  plugins: [gamesPlugin()],
  resolve: {
    alias: {
      // @dreamsy/format's Package imports node fs for fromDir/toDir; the browser only uses fromZip.
      "node:fs/promises": join(here, "dev/shims/fs.ts"),
      "node:path": join(here, "dev/shims/path.ts"),
    },
  },
  server: {
    // Tunnels (cloudflared/ngrok) for phones on venue Wi-Fi: accept any Host header in dev.
    allowedHosts: true,
    port: 2005,
    strictPort: true,
    host: true,
    fs: { allow: [repo] },
  },
  build: {
    outDir: join(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: { exclude: ["@dreamsy/format"] },
});
