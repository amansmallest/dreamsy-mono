import "./kits.js"; // registers kit dependencies for validation
import {
  applyOps,
  checkSvg,
  OpError,
  type Package,
  parseOps,
  validatePackage,
  type Issue,
  type Op,
  type StylePreset,
} from "@dreamsy/format";
import type { ImageGen, ImageRequest } from "./images.js";

/** 1×1 transparent PNG used while a generated image is in flight (keeps asset refs valid). */
const PLACEHOLDER_PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64",
));

export interface Emit {
  (type: string, data?: Record<string, unknown>): Promise<void>;
}

interface PendingImage {
  id: string;
  promise: Promise<void>;
  status: "running" | "done" | "failed";
  error?: string;
  reported: boolean;
}

/** Ids that already exist in the scene are rejected by ops; we track counts for progress UI. */
export interface OpStats { added: number; removed: number; changed: number; files: Set<string> }

/**
 * The agent's working copy. Only valid op batches advance `pkg`; images land asynchronously
 * (placeholder first, real bytes when generation finishes).
 */
export class Workspace {
  readonly stats: OpStats = { added: 0, removed: 0, changed: 0, files: new Set() };
  readonly opLog: { reason: string; ops: Op[] }[] = [];
  private images = new Map<string, PendingImage>();
  private blobSeq = 0;

  constructor(
    public pkg: Package,
    private readonly imageGen: ImageGen,
    private readonly emit: Emit,
    private readonly signal: AbortSignal,
    private readonly refImages: { mediaType: string; base64: string }[],
  ) {}

  style(): { preset: StylePreset; palette?: string[] } {
    const m = validatePackage(this.pkg).manifest;
    return { preset: m?.style.preset ?? "clean", palette: m?.style.palette };
  }

  packId(): string | undefined {
    return validatePackage(this.pkg).manifest?.style.pack;
  }

  // ---------- tools ----------

  readFiles(paths: string[]): string {
    return paths.map((p) => {
      const t = this.pkg.text(p);
      if (t === undefined) return `=== ${p} ===\n(does not exist)`;
      if (/\.(png|jpg|webp|glb|ogg|mp3|wav|ttf|otf)$/.test(p)) return `=== ${p} ===\n(binary, ${this.pkg.bytes(p)!.byteLength} bytes)`;
      return `=== ${p} ===\n${t}`;
    }).join("\n\n");
  }

  getEntities(ids: string[]): string {
    const { scenes } = validatePackage(this.pkg);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      let found: unknown = null;
      for (const [file, scene] of Object.entries(scenes)) {
        if (scene.entities[id]) { found = { scene: file, ...scene.entities[id] }; break; }
      }
      out[id] = found ?? "(does not exist)";
    }
    return JSON.stringify(out, null, 2);
  }

  /** Returns a result string for the model and whether the batch was applied. */
  applyOps(raw: unknown, reason: string): { text: string; applied: boolean; issues: Issue[] } {
    let ops: Op[];
    try {
      ops = parseOps(raw);
    } catch (e) {
      return { text: `REJECTED, nothing applied. ${(e as Error).message}`, applied: false, issues: [] };
    }
    const assetOps = ops.filter((o) => o.op === "put_asset");
    if (assetOps.length) return { text: "REJECTED: use generate_image for assets, not put_asset.", applied: false, issues: [] };
    let next: Package;
    try {
      next = applyOps(this.pkg, ops);
    } catch (e) {
      if (e instanceof OpError) return { text: `REJECTED, nothing applied. ${e.message}`, applied: false, issues: [] };
      throw e;
    }
    this.pkg = next;
    this.opLog.push({ reason, ops });
    for (const o of ops) {
      if (o.op === "add_entity" || o.op === "add_scene") this.stats.added++;
      else if (o.op === "remove_entity" || o.op === "remove_scene") this.stats.removed++;
      else if (o.op === "set_props" || o.op === "update_entity" || o.op === "move_entity" || o.op === "set_manifest") this.stats.changed++;
      if ("path" in o) this.stats.files.add(o.path);
    }
    const r = validatePackage(this.pkg);
    const errors = r.issues.filter((i) => i.severity === "error");
    const warnings = r.issues.filter((i) => i.severity === "warning");
    const lines = [`Applied ${ops.length} ops.`];
    if (errors.length) lines.push(`${errors.length} validation errors — fix them:`, ...errors.slice(0, 40).map(fmtIssue));
    else lines.push("Package is valid.");
    if (warnings.length) lines.push(`${warnings.length} warnings:`, ...warnings.slice(0, 10).map(fmtIssue));
    return { text: lines.join("\n"), applied: true, issues: r.issues };
  }

  /** Starts generation in the background; the asset exists immediately as a placeholder. */
  generateImage(args: { id: string; prompt: string; aspect: ImageRequest["aspect"] }): string {
    if (!this.imageGen.available) return "Image generation is unavailable right now. Use solid-color sprites/primitives instead.";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(args.id)) return `Invalid asset id "${args.id}": use lowercase_snake.`;
    const existing = this.images.get(args.id);
    if (existing?.status === "running") return `Asset "${args.id}" is already being generated.`;

    this.putAsset(args.id, PLACEHOLDER_PNG, "png", { model: "placeholder", prompt: args.prompt });
    const style = this.style();
    const pending: PendingImage = { id: args.id, status: "running", reported: false, promise: Promise.resolve() };
    void this.emit("asset.started", { id: args.id, prompt: args.prompt });
    pending.promise = this.imageGen.generate({
      prompt: args.prompt,
      style: style.preset,
      palette: style.palette,
      references: this.refImages,
      aspect: args.aspect,
    }, this.signal).then(async (img) => {
      this.putAsset(args.id, img.bytes, img.ext, { model: img.model, prompt: img.prompt });
      pending.status = "done";
      await this.emit("asset.done", { id: args.id });
    }, async (err: Error) => {
      pending.status = "failed";
      pending.error = err.message;
      await this.emit("asset.failed", { id: args.id, error: err.message });
    });
    this.images.set(args.id, pending);
    return `Generating "${args.id}" in the background. Reference it now as "asset:${args.id}" (kind image).`;
  }

  /** Model-drawn SVG sprite: validated and stored synchronously. Calling again replaces it. */
  drawSprite(args: { id: string; svg: string }, model: string): string {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(args.id)) return `Invalid sprite id "${args.id}": use lowercase_snake.`;
    const problem = checkSvg(args.svg);
    if (problem) return `REJECTED: ${problem}. Nothing saved.`;
    if (this.images.get(args.id)?.status === "running") return `"${args.id}" is being generated by generate_image; use another id.`;
    this.putAsset(args.id, new TextEncoder().encode(args.svg), "svg", { model, prompt: "drawn as SVG" });
    return `Saved sprite "${args.id}" (assets/${args.id}.svg). Reference it as "asset:${args.id}".`;
  }

  /** Notes about images that finished/failed since the last call, appended to tool results. */
  imageNotes(): string {
    const notes: string[] = [];
    for (const p of this.images.values()) {
      if (p.reported || p.status === "running") continue;
      p.reported = true;
      notes.push(p.status === "done"
        ? `[image "${p.id}" is ready]`
        : `[image "${p.id}" FAILED: ${p.error}. A transparent placeholder is in its place — retry generate_image or switch to a solid color.]`);
    }
    return notes.join("\n");
  }

  async waitForImages(timeoutMs: number) {
    const all = Promise.all([...this.images.values()].map((p) => p.promise));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private putAsset(id: string, bytes: Uint8Array, ext: string, source: { model: string; prompt: string }) {
    const blob = `b${this.blobSeq++}`;
    this.pkg = applyOps(this.pkg, [{
      op: "put_asset",
      id,
      blob,
      meta: { kind: "image", file: `${id}.${ext}`, source },
    }], { [blob]: bytes });
  }
}

export const fmtIssue = (i: Issue) => `- [${i.code}] ${i.file ?? ""}${i.id ? ` #${i.id}` : ""}: ${i.message}`;
