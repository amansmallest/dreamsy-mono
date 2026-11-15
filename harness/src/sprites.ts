import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, GLOBAL, scope, type Memory } from "./memory.js";

/**
 * Reusable sprite library. Every SVG sprite that ships in a build (draw_sprite or content builders)
 * is stored once, content-addressed: SVG text + metadata in `.data/sprites/`, and an index entry
 * (kind "sprite") in Memory so `find_sprites` can search it. Sprites carry the art-director score of
 * the build they shipped in; low scorers are not offered for reuse.
 */
export interface SpriteMeta {
  libId: string;
  assetId: string;
  description: string;
  pack: string | null;
  style: string;
  palette: string[];
  kits: string[];
  viewBox: string | null;
  width: number | null;
  height: number | null;
  gameId: string | null;
  /** Art-director score (1–10) of the build it shipped in; null if unreviewed. */
  score: number | null;
  /** Library sprite this one was adapted from. */
  from?: string | null;
}

export interface SpriteHit { meta: SpriteMeta; svg: string; samePack: boolean }

export const spriteLibId = (svg: string) => `spr_${createHash("sha256").update(svg).digest("hex").slice(0, 16)}`;

/** "fox_run_1" → "fox run 1" */
export const humanizeId = (id: string) => id.replace(/_/g, " ").trim();

export function svgBox(svg: string): { viewBox: string | null; width: number | null; height: number | null } {
  const m = svg.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
  if (!m) return { viewBox: null, width: null, height: null };
  return { viewBox: `${m[1]} ${m[2]} ${m[3]} ${m[4]}`, width: Number(m[3]), height: Number(m[4]) };
}

const MAX_RETURN_SVG = 4000;
/** Don't offer sprites from builds the art director scored below this. */
const MIN_SCORE = 6;

export class SpriteLibrary {
  /** Hits handed to the builder this process (lets draw_sprite's `from` resolve without a disk read). */
  private seen = new Map<string, { meta: SpriteMeta; svg: string }>();

  constructor(readonly memory: Memory, readonly dir: string = join(dataDir(), "sprites")) {}

  /** Store (or re-score) a shipped sprite. Returns its library id. */
  async store(svg: string, meta: Omit<SpriteMeta, "libId" | "viewBox" | "width" | "height">): Promise<string> {
    const libId = spriteLibId(svg);
    const prev = this.get(libId)?.meta;
    const full: SpriteMeta = {
      ...svgBox(svg), ...meta, libId,
      // A sprite seen again keeps its best score and first description.
      score: Math.max(meta.score ?? 0, prev?.score ?? 0) || null,
      description: prev?.description ?? meta.description,
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${libId}.svg`), svg);
    writeFileSync(join(this.dir, `${libId}.json`), JSON.stringify(full, null, 2));
    await this.memory.remember({
      id: libId,
      kind: "sprite",
      text: `${full.description}. sprite ${humanizeId(full.assetId)}${full.pack ? `, ${full.pack} pack` : ""}, ${full.style} style${full.width ? `, ${full.width}x${full.height}` : ""}`,
      scopes: [GLOBAL, ...(full.pack ? [scope.pack(full.pack)] : []), `style:${full.style}`, ...full.kits.map(scope.kit)],
      score: full.score,
      data: { ...full, ...(svg.length <= 6000 ? { svg } : {}) },
    });
    return libId;
  }

  get(libId: string): { meta: SpriteMeta; svg: string } | null {
    const hit = this.seen.get(libId);
    if (hit) return hit;
    if (!/^spr_[0-9a-f]{16}$/.test(libId)) return null;
    const svgPath = join(this.dir, `${libId}.svg`);
    if (!existsSync(svgPath)) return null;
    try {
      return { svg: readFileSync(svgPath, "utf8"), meta: JSON.parse(readFileSync(join(this.dir, `${libId}.json`), "utf8")) as SpriteMeta };
    } catch { return null; }
  }

  /** Best matching, well-scored sprites (same pack boosted in ranking; flagged when different). */
  async find(query: string, opts: { pack?: string | null; style?: string; limit?: number } = {}): Promise<SpriteHit[]> {
    const limit = Math.min(8, Math.max(1, opts.limit ?? 5));
    const hits = await this.memory.recall(query, { kinds: ["sprite"], pack: opts.pack ?? undefined, minScore: MIN_SCORE, limit: limit * 3 });
    const out: SpriteHit[] = [];
    for (const h of hits) {
      const local = this.get(h.item.id);
      const meta = local?.meta ?? (h.item.data as unknown as SpriteMeta | undefined);
      const svg = local?.svg ?? (typeof h.item.data?.svg === "string" ? h.item.data.svg : null);
      if (!meta || !svg) continue;
      this.seen.set(h.item.id, { meta, svg });
      out.push({ meta, svg, samePack: !!opts.pack && meta.pack === opts.pack });
    }
    return out.slice(0, limit);
  }
}

/** Tool result text for find_sprites. */
export function formatSpriteHits(hits: SpriteHit[], pack: string | null | undefined): string {
  if (!hits.length) return "No matching sprites in the library yet — draw it from scratch.";
  return [
    `${hits.length} library sprite(s). To use one, adapt it to THIS game's palette and art bible, then save it with draw_sprite (new id, from = the library id).${pack ? "" : " This game has no style pack: always adapt."}`,
    ...hits.map((h) => {
      const tag = h.samePack ? "same pack" : `DIFFERENT PACK (${h.meta.pack ?? "none"}) — must be restyled, never copied`;
      const svg = h.svg.length > MAX_RETURN_SVG ? `${h.svg.slice(0, MAX_RETURN_SVG)}… (truncated)` : h.svg;
      return `## ${h.meta.libId} — ${h.meta.description}\n${tag}; ${h.meta.style}${h.meta.viewBox ? `, viewBox ${h.meta.viewBox}` : ""}; art score ${h.meta.score ?? "?"}/10\n${svg}`;
    }),
  ].join("\n\n");
}
