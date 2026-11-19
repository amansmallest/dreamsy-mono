import Anthropic from "@anthropic-ai/sdk";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Package } from "@dreamsy/format";
import { generate } from "../pipeline/generate.js";
import { anthropicLLM } from "../llm/anthropic.js";
import { openaiJson, openaiLLM } from "../llm/openai.js";
import { failoverLLM, type Provider } from "../llm/failover.js";
import { disabledImages, geminiImages } from "../llm/images.js";
import { enginePlaytester } from "../engine/playtest.js";
import { cloudFromEnv, saveToCloud, type CloudSave } from "../cloud.js";

interface Input {
  dir: string;
  prompt: string;
  images?: { mediaType: string; base64: string }[];
  thumbnail?: string;
  cloud?: { gameId?: string | null; name: string };
}

const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function visible(dir: string) {
  return (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith("."));
}

async function main() {
  const input = JSON.parse(await readStdin()) as Input;
  const anthropicKey = process.env.DREAMSY_EDITOR_ANTHROPIC_KEY;
  const openaiKey = process.env.DREAMSY_EDITOR_OPENAI_KEY;
  const geminiKey = process.env.DREAMSY_EDITOR_GEMINI_KEY;

  const chain: Provider[] = [];
  if (anthropicKey) {
    const claude = anthropicLLM(new Anthropic({ apiKey: anthropicKey }));
    chain.push({ name: "anthropic", kind: "anthropic", agent: claude, json: claude });
  }
  if (openaiKey) chain.push({ name: "openai", kind: "openai", agent: openaiLLM(openaiKey), json: openaiJson(openaiKey) });
  if (!chain.length) {
    out({ type: "result", ok: false, message: "Add an Anthropic or OpenAI key in the editor settings." });
    return 2;
  }
  const llm = failoverLLM(chain, (m) => out({ type: "log", text: m }));
  const images = geminiKey ? await geminiImages(geminiKey) : disabledImages;
  const playtest = await enginePlaytester({ browser: process.env.PLAYTEST_BROWSER !== "0" });

  const ctl = new AbortController();
  process.on("SIGTERM", () => ctl.abort());
  process.on("SIGINT", () => ctl.abort());

  const t0 = Date.now();
  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    out({ type: "event", event: type, data, t: Date.now() - t0 });
  };

  try {
    const base = (await visible(input.dir)).length ? await Package.fromDir(input.dir) : Package.empty();
    const result = await generate({ agentLLM: llm, jsonLLM: llm, images, playtest, emit, signal: ctl.signal }, {
      base,
      prompt: input.prompt,
      images: input.images ?? [],
      selection: [],
    });
    if (!result.ok) {
      out({ type: "result", ok: false, message: result.message, cost: result.cost });
      return 1;
    }
    for (const f of await visible(input.dir)) await rm(join(input.dir, f), { recursive: true, force: true });
    await result.pkg.toDir(input.dir);
    if (result.thumbnail && input.thumbnail) await writeFile(input.thumbnail, result.thumbnail);
    let cloud: CloudSave | { error: string } | null = null;
    const cfg = cloudFromEnv();
    if (cfg) {
      try {
        cloud = await saveToCloud(cfg, {
          gameId: input.cloud?.gameId,
          name: /^name\s*=\s*"([^"]+)"/m.exec(result.pkg.text("dreamsy.toml") ?? "")?.[1] ?? input.cloud?.name ?? "Untitled game",
          pack: result.pkg.toPack(),
          label: input.prompt,
          thumbnail: result.thumbnail,
        });
        await emit("cloud.saved", { ...cloud });
      } catch (e) {
        cloud = { error: (e as Error).message };
        await emit("cloud.failed", { error: cloud.error });
      }
    }
    out({ type: "result", ok: true, summary: result.summary, kind: result.kind, cost: result.cost, cloud });
    return 0;
  } catch (e) {
    out({ type: "result", ok: false, message: ctl.signal.aborted ? "Canceled" : (e as Error).message });
    return 1;
  } finally {
    await playtest.close?.();
  }
}

process.exit(await main());
