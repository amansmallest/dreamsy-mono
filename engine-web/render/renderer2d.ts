// three.js renderer for 2D games: orthographic camera in world pixels (+y down), sprites as quads,
// Text2D via canvas textures, style render hints from @dreamsy/format, HTML overlay for UI.
import * as THREE from "three";
import { STYLES } from "@dreamsy/format";
import { NO_INSETS, parseColor, screenToWorld, text2DOrigin, view2D, type Entity, type Game, type Insets, type RGBA, type View2D } from "../core/index.js";
import { EMISSIVE_BASE, LightingOverlay } from "./lighting.js";
import { ParticlesView } from "./particles.js";
import { TextureCache } from "./textures.js";
import { FONT_STACKS, resolveTheme, type Theme } from "./theme.js";
import { TileMapView } from "./tilemap.js";
import { UIOverlay } from "./ui.js";

interface Node {
  e: Entity;
  obj: THREE.Object3D;
  mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  rev: number;
  textKey?: string;
  textSize?: [number, number, number];
  texRef?: string;
  tiles?: TileMapView;
  particles?: ParticlesView;
}

const SPATIAL = new Set(["Node2D", "Sprite2D", "Body2D", "Area2D", "Camera2D", "Text2D", "SpawnPoint2D", "TileMap2D", "Particles2D"]);

/** Unit quad with flipped V so textures read upright under the y-down world. */
function makeQuad(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

export interface Renderer2DOptions {
  /** Show physics shapes (debug). */
  debugShapes?: boolean;
}

export class Renderer2D {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly ui: UIOverlay;
  readonly textures: TextureCache;
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private nodes = new Map<Entity, Node>();
  private structureRev = -1;
  private quad = makeQuad();
  private pixel: boolean;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private texelsPerWorld = 1;
  lastView: View2D | null = null;
  readonly theme: Theme;
  /** Safe-area insets (container px): notch / home indicator. Set by GameView. */
  insets: Insets = NO_INSETS;
  private fitKey = "";
  /** Lighting2D darkness (+ Light2D holes); `emissive` entities draw above it. */
  readonly lighting = new LightingOverlay();
  private lit = false;

  constructor(private container: HTMLElement, readonly game: Game, private opts: Renderer2DOptions = {}) {
    const style = STYLES[game.manifest.style.preset];
    this.pixel = style.render.textureFilter === "nearest" && style.render.pixelSnap;
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.pixel, alpha: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", touchAction: "none" });
    if (this.pixel) this.canvas.style.imageRendering = "pixelated";
    container.appendChild(this.canvas);
    const bg = game.manifest.style.palette?.[0] ?? (this.pixel ? "#1a1c2c" : "#20232a");
    this.renderer.setClearColor(new THREE.Color(bg));
    this.theme = resolveTheme(game.manifest);
    // letterbox / pillarbox bars around the reference-aspect game rect
    container.style.background = this.theme.background;
    this.root.scale.y = -1;
    this.scene.add(this.root);
    this.scene.add(this.lighting.mesh);
    this.textures = new TextureCache(game, style.render.textureFilter === "nearest");
    this.ui = new UIOverlay(container, game, this.textures, this.pixel, this.theme);
  }

  /** Call when the container resizes (also checked every frame). */
  resize() {
    const r = this.container.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  }

  render() {
    const r = this.container.getBoundingClientRect();
    if (r.width !== this.width || r.height !== this.height || (globalThis.devicePixelRatio || 1) !== this.dpr) this.resize();
    const v = view2D(this.game, this.width, this.height);
    this.lastView = v;
    const f = v.fit;
    // canvas covers exactly the letterboxed game rect (whole CSS px so pixel art stays crisp)
    const cl = Math.round(f.x), ct = Math.round(f.y), cw = Math.max(1, Math.round(f.w)), ch = Math.max(1, Math.round(f.h));
    const key = `${cl},${ct},${cw},${ch}`;
    if (key !== this.fitKey) {
      this.fitKey = key;
      Object.assign(this.canvas.style, { inset: "auto", left: `${cl}px`, top: `${ct}px`, width: `${cw}px`, height: `${ch}px` });
    }

    // backbuffer size
    let bw: number, bh: number;
    if (this.pixel) {
      const k = Math.max(1, Math.floor(v.scale * this.dpr)); // device px per texel
      bw = Math.max(1, Math.round((cw * this.dpr) / k));
      bh = Math.max(1, Math.round((ch * this.dpr) / k));
    } else {
      const pr = Math.min(this.dpr, 2);
      bw = Math.round(cw * pr);
      bh = Math.round(ch * pr);
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== bw || size.y !== bh) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(bw, bh, false);
    }
    this.texelsPerWorld = (bw / cw) * v.scale;

    this.lit = this.lighting.sync(this.game, v.cx, v.cy, v.w, v.h);
    this.sync(v);

    let cx = v.cx, cy = v.cy;
    if (this.pixel) {
      cx = Math.round(cx * this.texelsPerWorld) / this.texelsPerWorld;
      cy = Math.round(cy * this.texelsPerWorld) / this.texelsPerWorld;
    }
    const cam = this.camera;
    cam.left = -v.w / 2; cam.right = v.w / 2; cam.top = v.h / 2; cam.bottom = -v.h / 2;
    cam.position.set(cx, -cy, 10);
    cam.updateProjectionMatrix();
    this.renderer.render(this.scene, cam);
    this.ui.update(this.width, this.height, f, this.insets);
  }

  private sync(v: View2D) {
    const game = this.game;
    if (game.world.structureRev !== this.structureRev) {
      this.structureRev = game.world.structureRev;
      for (const [e, n] of this.nodes) {
        if (!e.alive) {
          n.obj.removeFromParent();
          n.mesh?.material.dispose();
          n.tiles?.dispose();
          if (n.particles) { n.particles.mesh.removeFromParent(); n.particles.dispose(); }
          if (n.textKey) n.mesh?.material.map?.dispose();
          this.nodes.delete(e);
        }
      }
      for (const e of game.world.walk()) {
        let n = this.nodes.get(e);
        if (!n) {
          n = { e, obj: new THREE.Object3D(), rev: -1 };
          this.nodes.set(e, n);
        }
        const parentObj = e.parent ? this.nodes.get(e.parent)!.obj : this.root;
        if (n.obj.parent !== parentObj) parentObj.add(n.obj);
      }
    }

    // transforms, visuals and draw order (effective z, then tree order)
    let order = 0;
    const visit = (e: Entity, z: number) => {
      const n = this.nodes.get(e);
      if (!n) return;
      const zz = z + (e.def.props.z_index ? e.get<number>("z_index") : 0);
      // under Lighting2D, emissive things draw after (above) the darkness overlay
      const key = (this.lit && e.def.props.emissive && e.get<boolean>("emissive") ? EMISSIVE_BASE : 0) + zz * 100000 + order;
      if (n.rev !== e.rev) {
        n.rev = e.rev;
        this.updateNode(n);
      }
      if (n.mesh) {
        if (n.texRef && !n.mesh.material.map) this.updateNode(n); // texture finished loading
        n.mesh.renderOrder = key;
      }
      if (e.type === "TileMap2D") {
        if (!n.tiles) {
          n.tiles = new TileMapView(this.textures, () => (this.lastView ? this.lastView.scale : 1) * this.dpr);
          n.obj.add(n.tiles.group);
        }
        n.tiles.sync(e, key);
      }
      if (e.type === "Particles2D") {
        if (!n.particles) {
          n.particles = new ParticlesView(this.textures, this.pixel);
          this.root.add(n.particles.mesh); // particles live in world space
        }
        n.particles.sync(e, key, this.game.effectiveVisible(e));
        const blend = e.get<string>("blend") === "add" ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (n.particles.mesh.material.blending !== blend) { n.particles.mesh.material.blending = blend; n.particles.mesh.material.needsUpdate = true; }
      }
      order++;
      if (!n.obj.visible) return;
      for (const c of e.children) visit(c, zz);
    };
    visit(game.world.root, 0);
  }

  private updateNode(n: Node) {
    const e = n.e;
    const o = n.obj;
    o.visible = e.get<boolean>("visible") !== false;
    if (!SPATIAL.has(e.type)) return;
    const p = e.get<number[]>("position");
    o.position.set(p[0]!, p[1]!, 0);
    o.rotation.z = (e.get<number>("rotation") * Math.PI) / 180;
    const s = e.get<number[]>("scale");
    o.scale.set(s[0]! || 1e-6, s[1]! || 1e-6, 1);

    if (e.type === "Sprite2D") this.updateSprite(n);
    else if (e.type === "Text2D") this.updateText(n);
    else if (this.opts.debugShapes && (e.type === "Body2D" || e.type === "Area2D")) this.updateDebug(n);
  }

  private ensureMesh(n: Node) {
    if (!n.mesh) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      n.mesh = new THREE.Mesh(this.quad, mat);
      n.obj.add(n.mesh);
    }
    return n.mesh;
  }

  private updateSprite(n: Node) {
    const e = n.e;
    const mesh = this.ensureMesh(n);
    const size = e.get<number[]>("size");
    const flip = e.get<boolean>("flip_h") ? -1 : 1, flipV = e.get<boolean>("flip_v") ? -1 : 1;
    mesh.scale.set((size[0]! || 1e-6) * flip, (size[1]! || 1e-6) * flipV, 1);
    const c = (e.get<RGBA>("modulate") ?? [1, 1, 1, 1]) as RGBA;
    const mat = mesh.material;
    mat.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    mat.opacity = c[3];
    const blend = e.get<string>("blend") === "add" ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (mat.blending !== blend) { mat.blending = blend; mat.needsUpdate = true; }
    const ref = e.get<string | undefined>("texture");
    n.texRef = ref;
    if (ref) {
      const lv = this.lastView;
      const screenPx = Math.max(size[0]!, size[1]!) * (lv ? lv.scale : 1) * this.dpr * Math.max(Math.abs(e.get<number[]>("scale")[0]!), 1);
      const tex = this.textures.get(ref, screenPx);
      if (tex === undefined) { mesh.visible = false; return; }
      mesh.visible = true;
      if (tex === null) n.texRef = undefined; // missing asset: draw the solid rect
      if (mat.map !== (tex ?? null)) { mat.map = tex ?? null; mat.needsUpdate = true; }
    } else {
      mesh.visible = true;
      if (mat.map) { mat.map = null; mat.needsUpdate = true; }
    }
  }

  private updateText(n: Node) {
    const e = n.e;
    const text = e.get<string>("text") ?? "";
    const fontSize = e.get<number>("font_size");
    const col = e.get<RGBA>("color") as RGBA;
    const align = e.get<string>("align");
    const fontName = e.get<string>("font");
    const outline = e.get<RGBA>("outline") as RGBA, outlineSize = e.get<number>("outline_size");
    const shadow = e.get<RGBA>("shadow") as RGBA, shadowOff = e.get<number[]>("shadow_offset");
    const res = Math.max(1, Math.min(8, this.texelsPerWorld));
    const key = `${text}|${fontSize}|${col.join(",")}|${fontName}|${outline.join(",")}|${outlineSize}|${shadow.join(",")}|${shadowOff.join(",")}|${res.toFixed(2)}`;
    const mesh = this.ensureMesh(n);
    if (key !== n.textKey) {
      n.textKey = key;
      // rasterize at screen resolution for crisp text (pixel style: at texel resolution)
      const family = fontName && fontName !== "default" ? FONT_STACKS[fontName as Theme["font"]] : this.theme.fontFamily;
      const font = `bold ${fontSize * res}px ${family}`;
      const lines = text.split("\n");
      const measure = document.createElement("canvas").getContext("2d")!;
      measure.font = font;
      const lineH = Math.ceil(fontSize * res * 1.2);
      const ow = outline[3] > 0 ? outlineSize * res : 0;
      const hasShadow = shadow[3] > 0;
      const sx = hasShadow ? shadowOff[0]! * res : 0, sy = hasShadow ? shadowOff[1]! * res : 0;
      const pad = Math.ceil(ow + 2 * res + Math.max(Math.abs(sx), Math.abs(sy)));
      const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width)) + 2 * pad));
      const h = Math.max(1, lineH * lines.length + 2 * pad);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      const rgba = (c: RGBA) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
      ctx.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
      const x = align === "left" ? pad : align === "right" ? w - pad : w / 2;
      const draw = (dx: number, dy: number, fill: string, stroke: boolean) => lines.forEach((l, i) => {
        const y = pad + lineH * (i + 0.5) + dy;
        if (stroke && ow > 0) ctx.strokeText(l, x + dx, y);
        ctx.fillText(l, x + dx, y);
      });
      if (ow > 0) { ctx.strokeStyle = rgba(outline); ctx.lineWidth = ow * 2; }
      if (hasShadow) { ctx.fillStyle = rgba(shadow); if (ow > 0) ctx.strokeStyle = rgba(shadow); draw(sx, sy, "", true); if (ow > 0) ctx.strokeStyle = rgba(outline); }
      ctx.fillStyle = rgba(col);
      draw(0, 0, "", true);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      if (this.pixel) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; }
      mesh.material.map?.dispose();
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
      n.textSize = [w / res, h / res, pad / res];
    }
    const [w, h, pad] = n.textSize!;
    mesh.scale.set(w, h, 1);
    // shared anchor rule (core text2DOrigin): the text block (without padding) is placed by `align`
    const [ox] = text2DOrigin(align, w - 2 * pad!, h);
    mesh.position.x = ox + w / 2 - pad!;
    mesh.visible = text.length > 0;
  }

  private updateDebug(n: Node) {
    const e = n.e;
    const mesh = this.ensureMesh(n);
    const size = e.get<number[]>("size");
    mesh.scale.set(size[0]!, size[1]!, 1);
    mesh.material.color.set(e.type === "Area2D" ? 0x00ff88 : 0xff3366);
    mesh.material.opacity = 0.25;
  }

  /** Screen (CSS px, relative to the container) → world. */
  screenToWorld(sx: number, sy: number): [number, number] {
    const v = this.lastView ?? view2D(this.game, this.width, this.height);
    return screenToWorld(v, sx, sy);
  }

  /** Canvas-local CSS px (the letterboxed game rect) → world. */
  canvasToWorld(x: number, y: number): [number, number] {
    const v = this.lastView ?? view2D(this.game, this.width, this.height);
    return screenToWorld(v, x + v.fit.x, y + v.fit.y);
  }

  /** Canvas-local CSS px → reference (UI) px. */
  canvasToRef(x: number, y: number): [number, number] {
    const v = this.lastView ?? view2D(this.game, this.width, this.height);
    return [x / v.fit.s, y / v.fit.s];
  }

  get size(): [number, number] { return [this.width, this.height]; }

  dispose() {
    for (const n of this.nodes.values()) { n.mesh?.material.dispose(); n.tiles?.dispose(); n.particles?.dispose(); }
    this.lighting.dispose();
    this.nodes.clear();
    this.textures.dispose();
    this.ui.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

export { parseColor };
