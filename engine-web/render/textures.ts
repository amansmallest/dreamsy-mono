import * as THREE from "three";
import type { Game } from "../core/index.js";

/**
 * Image assets → three.js textures, cached per asset id.
 * - PNG/JPG/WebP: decoded once.
 * - SVG: Blob → object URL → Image, rasterized onto a canvas. Pixel style rasterizes at the
 *   viewBox's native size (NearestFilter keeps it crisp); other styles rasterize at the on-screen
 *   size × devicePixelRatio, bucketed to powers of two, re-rasterizing only when a larger size is needed.
 * Swapping `texture` at runtime is a map lookup once an asset has loaded.
 */
export class TextureCache {
  private images = new Map<string, Promise<HTMLImageElement | null>>();
  private loaded = new Map<string, HTMLImageElement | null>();
  private textures = new Map<string, { tex: THREE.Texture; px: number }>();
  private urls = new Map<string, string>();
  private pending = new Set<string>();

  constructor(private game: Game, private nearest: boolean) {}

  /** Object URL for an asset (also used by the UI overlay). */
  url(id: string): string | undefined {
    let u = this.urls.get(id);
    if (u) return u;
    const meta = this.game.assets[id];
    if (!meta || meta.kind !== "image") return undefined;
    const bytes = this.game.pkg.bytes(`assets/${meta.file}`);
    if (!bytes) return undefined;
    const ext = meta.file.split(".").pop()!;
    const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    u = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    this.urls.set(id, u);
    return u;
  }

  private image(id: string): HTMLImageElement | null | undefined {
    if (this.loaded.has(id)) return this.loaded.get(id);
    if (!this.images.has(id)) {
      const u = this.url(id);
      const p = new Promise<HTMLImageElement | null>((resolve) => {
        if (!u) return resolve(null);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { console.warn(`[dreamsy] failed to decode image asset "${id}"`); resolve(null); };
        img.src = u;
      }).then((img) => { this.loaded.set(id, img); return img; });
      this.images.set(id, p);
    }
    return undefined;
  }

  private isSvg(id: string) {
    return this.game.assets[id]?.file.endsWith(".svg") ?? false;
  }

  /**
   * Texture for `asset:<id>` displayed at roughly `screenPx` device pixels (longest side).
   * Returns undefined while loading, null if the asset is missing/broken.
   */
  get(ref: string, screenPx: number): THREE.Texture | null | undefined {
    const id = ref.replace(/^asset:/, "");
    const img = this.image(id);
    if (img === undefined) return undefined;
    if (img === null) return null;
    const svg = this.isSvg(id);
    let px = 0;
    if (svg && !this.nearest) {
      px = 32;
      while (px < screenPx && px < 2048) px *= 2;
    }
    const cached = this.textures.get(id);
    if (cached && cached.px >= px) return cached.tex;
    let tex: THREE.Texture;
    if (!svg) {
      tex = new THREE.Texture(img);
    } else {
      // native size: SVG intrinsic size (width/height attrs or viewBox)
      const [nw, nh] = this.svgSize(id, img);
      let w = nw, h = nh;
      if (px > 0) {
        const k = px / Math.max(nw, nh);
        w = Math.max(1, Math.round(nw * k));
        h = Math.max(1, Math.round(nh * k));
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = !this.nearest;
      ctx.drawImage(img, 0, 0, w, h);
      tex = new THREE.CanvasTexture(canvas);
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    if (this.nearest) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    } else {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    tex.needsUpdate = true;
    cached?.tex.dispose();
    this.textures.set(id, { tex, px });
    return tex;
  }

  private svgSize(id: string, img: HTMLImageElement): [number, number] {
    const text = this.game.pkg.text(`assets/${this.game.assets[id]!.file}`) ?? "";
    const head = /<svg[^>]*>/i.exec(text)?.[0] ?? "";
    const vb = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(head);
    const wa = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(head), ha = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(head);
    if (wa && ha) return [Math.ceil(Number(wa[1])), Math.ceil(Number(ha[1]))];
    if (vb) return [Math.max(1, Math.ceil(Number(vb[1]))), Math.max(1, Math.ceil(Number(vb[2])))];
    return [img.naturalWidth || 64, img.naturalHeight || 64];
  }

  /** Resolves when every image asset has been decoded (used by screenshots/tests). */
  async preloadAll(): Promise<void> {
    const ids = Object.entries(this.game.assets).filter(([, m]) => m.kind === "image").map(([id]) => id);
    for (const id of ids) this.image(id);
    await Promise.all(ids.map((id) => this.images.get(id)));
  }

  dispose() {
    for (const { tex } of this.textures.values()) tex.dispose();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.textures.clear();
    this.urls.clear();
    this.pending.clear();
  }
}
