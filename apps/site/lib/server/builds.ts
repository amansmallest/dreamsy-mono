import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BuildEvent, BuildRecord, Provider, StreamMessage } from "../editor-types";
import { cloudUrl, linkCloud, linkedCloudId, saveKey } from "./cloud";
import { history, meta, saveHistory, snapshot } from "./games";
import { dataDir, gameDir, HARNESS_DIR, HttpError } from "./paths";

interface Run {
  record: BuildRecord;
  child: ChildProcess;
  listeners: Set<(m: StreamMessage) => void>;
  canceled: boolean;
}

const QUIET = new Set(["working", "heartbeat", "eta", "metrics"]);
const g = globalThis as unknown as { __dreamsyRuns?: Map<string, Run> };
const runs = (g.__dreamsyRuns ??= new Map<string, Run>());

export const activeRun = (id: string) => runs.get(id);

export function subscribe(id: string, fn: (m: StreamMessage) => void) {
  const run = runs.get(id);
  if (!run) return null;
  run.listeners.add(fn);
  return { record: run.record, off: () => run.listeners.delete(fn) };
}

async function persist(id: string, record: BuildRecord) {
  const all = await history(id);
  const stored = { ...record, events: record.events.filter((e) => !QUIET.has(e.event)).slice(-400) };
  const i = all.findIndex((b) => b.id === record.id);
  if (i >= 0) all[i] = stored;
  else all.push(stored);
  await saveHistory(id, all);
}

export async function startBuild(id: string, prompt: string, images: { mediaType: string; base64: string }[], keys: Partial<Record<Provider, string>>) {
  if (runs.has(id)) throw new HttpError(409, "A build is already running for this game");
  if (!keys.anthropic && !keys.openai) throw new HttpError(400, "Add an Anthropic or OpenAI key in settings first");
  const text = prompt.trim();
  if (!text) throw new HttpError(400, "Write what you want to build");

  const prior = await history(id);
  if (prior.length === 0) await snapshot(id, "Before Dreamsy").catch(() => null);
  await mkdir(dataDir(id), { recursive: true });

  const cloud = cloudUrl();
  const key = cloud ? await saveKey() : "";
  const record: BuildRecord = { id: `b${Date.now().toString(36)}`, prompt: text, images: images.length, at: Date.now(), status: "running", events: [] };
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/editor.ts"], {
    cwd: HARNESS_DIR,
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PLAYTEST_BROWSER: process.env.PLAYTEST_BROWSER ?? "1",
      DREAMSY_EDITOR_ANTHROPIC_KEY: keys.anthropic ?? "",
      DREAMSY_EDITOR_OPENAI_KEY: keys.openai ?? "",
      DREAMSY_EDITOR_GEMINI_KEY: keys.gemini ?? "",
      DREAMSY_CLOUD_URL: cloud ?? "",
      DREAMSY_SAVE_KEY: key,
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const run: Run = { record, child, listeners: new Set(), canceled: false };
  runs.set(id, run);
  const send = (m: StreamMessage) => run.listeners.forEach((fn) => fn(m));

  const m = await meta(id);
  child.stdin!.end(JSON.stringify({ dir: gameDir(id), prompt: text, images, thumbnail: join(dataDir(id), "thumb.jpg"), cloud: { gameId: await linkedCloudId(id), name: m.name ?? id } }));

  let buffer = "";
  let stderr = "";
  let result: { ok: boolean; summary?: string; message?: string; cost?: { usd?: number }; cloud?: BuildRecord["cloud"] | null } | null = null;
  let lastSave = 0;

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg: { type: string; event?: string; data?: Record<string, unknown>; t?: number } & typeof result;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "event" && msg.event) {
        const ev: BuildEvent = { event: msg.event, data: msg.data ?? {}, t: msg.t ?? 0 };
        record.events.push(ev);
        send({ type: "event", buildId: record.id, event: ev });
        if (Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          void persist(id, record);
        }
      } else if (msg.type === "result") result = msg;
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });

  child.on("close", async () => {
    record.seconds = Math.round((Date.now() - record.at) / 1000);
    record.usd = result?.cost?.usd;
    if (run.canceled) {
      record.status = "canceled";
    } else if (result?.ok) {
      record.status = "succeeded";
      record.summary = result.summary;
      record.version = (await snapshot(id, text, record.id).catch(() => null)) ?? undefined;
      if (result.cloud) {
        record.cloud = result.cloud;
        if ("gameId" in result.cloud) await linkCloud(id, result.cloud.gameId);
      }
    } else {
      record.status = "failed";
      record.error = result?.message ?? (stderr.trim().split("\n").slice(-4).join("\n") || "The build stopped unexpectedly");
    }
    await persist(id, record);
    runs.delete(id);
    send({ type: "done", build: { ...record } });
  });

  await persist(id, record);
  return record;
}

export function cancelBuild(id: string) {
  const run = runs.get(id);
  if (!run) return false;
  run.canceled = true;
  run.child.kill("SIGTERM");
  setTimeout(() => run.child.exitCode === null && run.child.kill("SIGKILL"), 8000);
  return true;
}
