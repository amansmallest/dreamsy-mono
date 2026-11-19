import Anthropic from "@anthropic-ai/sdk";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { anthropicKey, geminiKey, loadEnv } from "../env.js";
import { generate } from "../pipeline/generate.js";
import { disabledImages, geminiImages } from "../llm/images.js";
import { anthropicLLM } from "../llm/anthropic.js";
import type { AgentLLM } from "../llm/models.js";
import { openaiJson, openaiLLM } from "../llm/openai.js";
import { failoverLLM, type Provider } from "../llm/failover.js";
import { ApiClient, runWorker } from "../jobs/worker.js";
import { enginePlaytester } from "../engine/playtest.js";
import { createMemory } from "../memory/memory.js";
import { SpriteLibrary } from "../memory/sprites.js";
import { linkedGame, linkGame, localCloud, saveToCloud } from "../cloud.js";

loadEnv();

const USAGE = `harness <command>
  worker                         pull jobs from the API forever
      env: DREAMSY_API_URL (default http://localhost:8787), WORKER_TOKEN, WORKER_CONCURRENCY (2),
           WORKER_MAX_ROUNDS (4): new games keep building milestones, saving a playable version per round
           SUPERMEMORY_API_KEY (optional): retrieval memory in Supermemory; else .data/memory. DREAMSY_MEMORY=0 disables
  local --prompt "..." --out <dir|zip> [--base <dir|zip>] [--image ref.png]... [--select id,id] [--rounds N]
                                 --rounds: keep building ("continue") until notes.md has no unchecked milestones (max N sessions)
                                 run one generation locally (no API); prints events + cost
      every round is also saved to the Dreamsy cloud under this computer's save key (~/.dreamsy); DREAMSY_CLOUD=0 turns it off`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
}

async function setup() {
  const key = anthropicKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY (or ANTHROPIC_KEY) is not set; put it in the repo-root .env");
  const claude = anthropicLLM(new Anthropic({ apiKey: key }));
  const anth: Provider = { name: "anthropic", kind: "anthropic", agent: claude, json: claude };
  const oai = [process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_BACKUP]
    .filter((k): k is string => !!k)
    .map((k, i): Provider => ({ name: i === 0 ? "openai" : "openai-backup", kind: "openai", agent: openaiLLM(k), json: openaiJson(k) }));
  const llm = failoverLLM([anth, ...oai]);
  let builder: AgentLLM = llm;
  if (process.env.DREAMSY_PROVIDER === "openai") {
    if (!oai.length) throw new Error("DREAMSY_PROVIDER=openai needs OPENAI_API_KEY");
    builder = failoverLLM([...oai, anth]);
  }
  const gk = geminiKey();
  const images = gk ? await geminiImages(gk) : disabledImages;
  const playtest = await enginePlaytester({ browser: process.env.PLAYTEST_BROWSER !== "0" });
  const memory = process.env.DREAMSY_MEMORY === "0" ? undefined : createMemory();
  const sprites = memory ? new SpriteLibrary(memory) : undefined;
  if (memory) console.error(`memory: ${memory.backend}`);
  return { llm, builder, images, playtest, memory, sprites };
}

async function loadPkg(path: string): Promise<Package> {
  return (await stat(path)).isDirectory() ? Package.fromDir(path) : Package.fromZip(new Uint8Array(await readFile(path)));
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const cmd = process.argv[2];
if (cmd === "worker") {
  const { llm, builder, images, playtest, memory, sprites } = await setup();
  const token = process.env.WORKER_TOKEN;
  if (!token) throw new Error("WORKER_TOKEN is required");
  const api = new ApiClient(process.env.DREAMSY_API_URL ?? "http://localhost:8787", token);
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  console.log(`harness worker ${api.workerId} → ${process.env.DREAMSY_API_URL ?? "http://localhost:8787"}`);
  await runWorker({ api, agentLLM: builder, jsonLLM: llm, images, playtest, memory, sprites, maxRounds: Number(process.env.WORKER_MAX_ROUNDS ?? 4) }, {
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    idleMs: 1000,
    signal: ctl.signal,
  });
} else if (cmd === "local") {
  const prompt = arg("prompt");
  const out = arg("out");
  if (!prompt || !out) { console.error(USAGE); process.exit(1); }
  const { llm, builder, images, playtest, memory, sprites } = await setup();
  const base = arg("base") ? await loadPkg(arg("base")!) : Package.empty();
  const refs = await Promise.all(args("image").map(async (p) => ({
    mediaType: MIME[extname(p).toLowerCase()] ?? "image/png",
    base64: (await readFile(p)).toString("base64"),
  })));
  const t0 = Date.now();
  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
    console.error(`${sec}s  ${type.padEnd(14)} ${JSON.stringify(data).slice(0, 300)}`);
  };
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  const rounds = Math.max(1, Number(arg("rounds") ?? 1));
  let pkg = base;
  let ok = false;
  let total = 0;
  const outDir = resolve(out);
  let cloudGameId: string | null = process.env.DREAMSY_CLOUD_GAME ?? linkedGame(outDir);
  for (let round = 1; round <= rounds; round++) {
    const isFirst = round === 1;
    const result = await generate(
      { agentLLM: builder, jsonLLM: llm, images, playtest, emit, signal: ctl.signal, memory, sprites },
      {
        base: pkg,
        prompt: isFirst ? prompt : "continue: build the next unchecked milestones in notes.md with the same quality, playtest them, and update notes.md",
        images: isFirst ? refs : [],
        selection: isFirst ? arg("select")?.split(",").filter(Boolean) ?? [] : [],
      },
    );
    total += result.cost.usd;
    console.error(`\n[round ${round}/${rounds}] ${result.ok ? "✓" : "✗"} ${result.ok ? result.summary : result.message}`);
    console.error(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, $${result.cost.usd} this round, $${total.toFixed(2)} total`);
    if (!result.ok) break;
    ok = true;
    pkg = result.pkg;
    if (out.endsWith(".zip")) await writeFile(out, pkg.toZip());
    else await pkg.toDir(out);
    console.error(`  wrote ${out}`);
    const cloud = localCloud();
    if (cloud) {
      try {
        const saved = await saveToCloud(cloud, { gameId: cloudGameId, name: /^name\s*=\s*"([^"]+)"/m.exec(pkg.text("dreamsy.toml") ?? "")?.[1] ?? "Untitled game", pack: pkg.toPack(), label: isFirst ? prompt : `round ${round}`, thumbnail: result.thumbnail });
        cloudGameId = saved.gameId;
        linkGame(outDir, saved.gameId);
        console.error(`  saved to cloud: game ${saved.gameId} v${saved.version}`);
      } catch (e) {
        console.error(`  cloud save failed: ${(e as Error).message}`);
      }
    }
    const notes = pkg.text("notes.md") ?? "";
    if (!/\[ \]/.test(notes)) { console.error("  all milestones done"); break; }
  }
  await playtest.close?.();
  process.exit(ok ? 0 : 1);
} else {
  console.error(USAGE);
  process.exit(cmd ? 1 : 0);
}
