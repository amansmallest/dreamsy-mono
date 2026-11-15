// UI entities (UIText / UIButton / UIPanel), toasts and ui.dialog / ui.choice as an HTML overlay.
// Layout is in reference pixels (portrait 720×1280 / landscape 1280×720, core/view2d.ts): the layer
// covers the letterboxed game rect and is scaled to CSS pixels. Top-level UI anchors to the safe area
// (notch / home indicator insets that reach into the game rect); children anchor inside their panel.
import { anchorRect, NO_INSETS, safeInsets, uiChildRect, type Entity, type Fit, type Game, type Insets, type RGBA } from "../core/index.js";
import type { TextureCache } from "./textures.js";
import { FONT_STACKS, onColor, panelSurface, withAlpha, type Theme } from "./theme.js";

const UI_TYPES = new Set(["UIText", "UIButton", "UIPanel"]);

const css = (c: RGBA) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

interface UINode { e: Entity; el: HTMLElement; rev: number; key: string }

/** CSS text-shadow for an outline (ring of offsets) plus an optional drop shadow. */
export function textShadowCss(outline: RGBA, outlineSize: number, shadow: RGBA, shadowOffset: number[], fallback: string): string {
  const parts: string[] = [];
  if (shadow[3] > 0) parts.push(`${shadowOffset[0]}px ${shadowOffset[1]}px 0 ${css(shadow)}`);
  if (outline[3] > 0 && outlineSize > 0) {
    const steps = outlineSize <= 1 ? 8 : 16;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      parts.push(`${(Math.cos(a) * outlineSize).toFixed(2)}px ${(Math.sin(a) * outlineSize).toFixed(2)}px 0 ${css(outline)}`);
    }
  }
  return parts.length ? parts.reverse().join(", ") : fallback;
}

export class UIOverlay {
  readonly root: HTMLDivElement;
  private layer: HTMLDivElement;
  private toastBox: HTMLDivElement;
  private dialogEl: HTMLDivElement;
  private nodes = new Map<Entity, UINode>();
  private structureRev = -1;
  private toastKey = "";
  private dialogKey = "";
  private layoutKey = "";
  private safe: Insets = NO_INSETS;
  private stackSig = new WeakMap<Entity, string>();
  private s = 1;

  constructor(container: HTMLElement, private game: Game, private textures: TextureCache, private pixel: boolean, private theme: Theme) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", userSelect: "none", webkitUserSelect: "none" });
    this.layer = document.createElement("div");
    Object.assign(this.layer.style, { position: "absolute", left: "0", top: "0", transformOrigin: "0 0", fontFamily: theme.fontFamily });
    this.root.appendChild(this.layer);
    this.toastBox = document.createElement("div");
    Object.assign(this.toastBox.style, {
      position: "absolute", left: "50%", top: "18%", transform: "translateX(-50%)", display: "flex", flexDirection: "column",
      alignItems: "center", gap: "8px", pointerEvents: "none", zIndex: "100000", width: "86%",
    });
    this.layer.appendChild(this.toastBox);
    this.dialogEl = document.createElement("div");
    Object.assign(this.dialogEl.style, { position: "absolute", inset: "0", display: "none", zIndex: "120000", pointerEvents: "auto" });
    this.dialogEl.dataset.dreamsyDialog = "";
    this.dialogEl.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); ev.preventDefault(); this.game.dialogTap(-1); });
    this.layer.appendChild(this.dialogEl);
    container.appendChild(this.root);
    // input.pointer() keeps tracking while a finger is on UI (buttons, panels, scroll lists, dialogs)
    const active = new Set<number>();
    const toRef = (ev: PointerEvent): [number, number] => {
      const r = this.layer.getBoundingClientRect();
      return [(ev.clientX - r.left) / this.s, (ev.clientY - r.top) / this.s];
    };
    this.root.addEventListener("pointerdown", (ev) => { active.add(ev.pointerId); const [x, y] = toRef(ev); this.game.pointerDown(x, y); }, true);
    this.root.addEventListener("pointermove", (ev) => { if (active.has(ev.pointerId)) { const [x, y] = toRef(ev); this.game.pointerMove(x, y); } }, true);
    const end = (ev: PointerEvent) => { if (active.delete(ev.pointerId)) { const [x, y] = toRef(ev); this.game.pointerUp(x, y); } };
    this.root.addEventListener("pointerup", end, true);
    this.root.addEventListener("pointercancel", end, true);
  }

  /** w, h: container size; fit: letterboxed game rect; insets: safe-area insets (container px). */
  update(w: number, h: number, fit: Fit, insets: Insets = NO_INSETS) {
    const s = fit.s;
    this.s = s;
    const safe = safeInsets(fit, insets, w, h);
    const lk = `${fit.x},${fit.y},${s},${safe.top},${safe.right},${safe.bottom},${safe.left}`;
    const relayout = lk !== this.layoutKey;
    if (relayout) {
      this.layoutKey = lk;
      this.safe = safe;
      Object.assign(this.layer.style, { left: `${fit.x}px`, top: `${fit.y}px`, width: `${fit.refW}px`, height: `${fit.refH}px`, transform: `scale(${s})` });
      this.toastBox.style.top = `${safe.top + fit.refH * 0.16}px`;
    }

    const world = this.game.world;
    if (world.structureRev !== this.structureRev) {
      this.structureRev = world.structureRev;
      for (const [e, n] of this.nodes) if (!e.alive) { n.el.remove(); this.nodes.delete(e); }
      for (const e of world.walk()) {
        if (!UI_TYPES.has(e.type)) continue;
        let n = this.nodes.get(e);
        if (!n) {
          n = { e, el: this.createEl(e), rev: -1, key: "" };
          this.nodes.set(e, n);
        }
        let parentEl: HTMLElement = this.layer;
        for (let p = e.parent; p; p = p.parent) {
          const pn = UI_TYPES.has(p.type) ? this.nodes.get(p) : undefined;
          if (pn) { parentEl = pn.el; break; }
        }
        if (n.el.parentElement !== parentEl) parentEl.insertBefore(n.el, parentEl === this.layer ? this.toastBox : null);
      }
      // scroll lists recompute their content height when children come and go
      for (const n of this.nodes.values()) if (n.e.type === "UIPanel" && n.e.get<boolean>("scroll")) n.rev = -1;
    }
    // stacked panels: when a child's size/offset/visibility changes, every later sibling moves
    for (const n of this.nodes.values()) {
      const e = n.e;
      if (e.type !== "UIPanel" || e.get<string>("layout") !== "stack") continue;
      const sig = e.children.map((c) => `${c.handle}:${c.rev}`).join(",") + `|${e.rev}`;
      if (sig !== this.stackSig.get(e)) {
        this.stackSig.set(e, sig);
        n.rev = -1;
        for (const c of e.children) { const cn = this.nodes.get(c); if (cn) cn.rev = -1; }
      }
    }
    for (const n of this.nodes.values()) {
      // non-UI ancestors (Folders) can hide UI too
      let hidden = false;
      for (let p = n.e.parent; p && !UI_TYPES.has(p.type); p = p.parent) if (p.get<boolean>("visible") === false) hidden = true;
      const want = hidden || n.e.get<boolean>("visible") === false ? "none" : "flex";
      if (n.el.style.display !== want) n.el.style.display = want;
      if (n.rev !== n.e.rev || relayout) { n.rev = n.e.rev; this.style(n); }
    }

    const key = this.game.toasts.map((t) => t.id).join(",");
    if (key !== this.toastKey) {
      this.toastKey = key;
      this.toastBox.replaceChildren(...this.game.toasts.map((t) => {
        const d = document.createElement("div");
        d.textContent = t.text;
        Object.assign(d.style, {
          background: withAlpha(this.theme.background, 0.88), color: this.theme.text, font: `700 ${this.theme.font === "pixel" ? 22 : 28}px ${this.theme.fontFamily}`,
          padding: "12px 22px", whiteSpace: "pre-wrap", textAlign: "center", maxWidth: "100%", boxSizing: "border-box",
          ...panelSurface(this.theme, withAlpha(this.theme.background, 0.9), true),
        });
        return d;
      }));
    }
    this.updateDialog(relayout);
  }

  // ------------------------------------------------------------------ dialogs

  private updateDialog(force: boolean) {
    const d = this.game.dialogs.current;
    const key = d ? `${d.id}|${d.index}|${Math.floor(d.shown)}|${d.selected}|${this.game.dialogs.rev}` : "";
    if (key === this.dialogKey && !force) return;
    this.dialogKey = key;
    const root = this.dialogEl;
    if (!d) { root.style.display = "none"; root.replaceChildren(); return; }
    root.style.display = "block";
    root.style.pointerEvents = d.blocking ? "auto" : "none";
    const t = this.theme, refW = parseFloat(this.layer.style.width) || 1280, portrait = (parseFloat(this.layer.style.height) || 720) > refW;
    const line = d.lines[d.index]!;
    const lineDone = d.shown >= line.text.length;
    const isLast = d.index >= d.lines.length - 1;
    const margin = portrait ? 24 : 40;
    const fs = t.font === "pixel" ? (portrait ? 26 : 24) : portrait ? 34 : 30;
    const box = el("div", {
      position: "absolute", left: `${this.safe.left + margin}px`, right: `${this.safe.right + margin}px`,
      [d.position === "top" ? "top" : "bottom"]: `${(d.position === "top" ? this.safe.top : this.safe.bottom) + margin + (d.position === "top" ? 64 : 0)}px`,
      boxSizing: "border-box", padding: portrait ? "26px 28px 30px" : "22px 28px 26px", display: "flex", gap: "22px", alignItems: "flex-start",
      color: t.text, pointerEvents: "auto", minHeight: portrait ? "220px" : "170px",
      ...panelSurface(t, withAlpha(t.background, 0.95), false),
    } as Partial<CSSStyleDeclaration>);
    if (line.portrait) {
      const url = this.textures.url(line.portrait.replace(/^asset:/, ""));
      if (url) {
        const img = el("div", {
          ...panelSurface(t, withAlpha(t.text, 0.08), true),
          width: portrait ? "136px" : "120px", height: portrait ? "136px" : "120px", flex: "none",
        });
        // after the surface: its `background` shorthand would reset the image
        Object.assign(img.style, { backgroundImage: `url("${url}")`, backgroundSize: "84%", backgroundRepeat: "no-repeat", backgroundPosition: "center", imageRendering: this.pixel ? "pixelated" : "auto" });
        box.append(img);
      }
    }
    const col = el("div", { display: "flex", flexDirection: "column", gap: "10px", flex: "1", minWidth: "0" });
    if (line.speaker) {
      col.append(el("div", {
        color: t.accent, font: `800 ${Math.round(fs * 0.8)}px ${t.fontFamily}`, letterSpacing: t.font === "pixel" ? "0.06em" : "0.01em",
        textTransform: t.font === "pixel" ? "uppercase" : "none",
      }, line.speaker));
    }
    const visible = line.text.slice(0, Math.floor(d.shown));
    const text = el("div", { font: `600 ${fs}px/1.35 ${t.fontFamily}`, whiteSpace: "pre-wrap", wordBreak: "break-word" }, visible);
    // reserve the full text's height so the box doesn't grow while typing
    const ghost = el("span", { visibility: "hidden" }, line.text.slice(visible.length));
    text.append(ghost);
    col.append(text);
    if (d.kind === "choice" && isLast) {
      const opts = el("div", { display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px", visibility: lineDone ? "visible" : "hidden" });
      d.options.forEach((label, i) => {
        const sel = i === d.selected;
        const b = el("button", {
          font: `700 ${Math.round(fs * 0.9)}px ${t.fontFamily}`, color: sel ? onColor(t.primary, "#ffffff") : t.text, padding: portrait ? "18px 20px" : "14px 18px",
          textAlign: "left", cursor: "pointer", minHeight: "64px", ...panelSurface(t, sel ? t.primary : withAlpha(t.text, 0.12), true),
          ...(t.panel === "outlined" ? { background: sel ? t.primary : "transparent", border: `2px solid ${sel ? t.primary : t.text}` } : {}),
        }, `${sel ? "▶ " : ""}${label}`);
        b.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); ev.preventDefault(); this.game.dialogTap(i); });
        opts.append(b);
      });
      col.append(opts);
    } else if (lineDone) {
      col.append(el("div", { position: "absolute", right: "22px", bottom: "12px", color: t.accent, font: `700 ${Math.round(fs * 0.8)}px ${t.fontFamily}`, animation: "none" }, "▼"));
    }
    box.append(col);
    box.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); ev.preventDefault(); this.game.dialogTap(-1); });
    root.replaceChildren(box);
  }

  // ------------------------------------------------------------------ entities

  /** Is the entity inside a scrolling UIPanel? (buttons then press on click, so drags scroll instead) */
  private inScroll(e: Entity): boolean {
    for (let p = e.parent; p && UI_TYPES.has(p.type); p = p.parent) if (p.type === "UIPanel" && p.get<boolean>("scroll")) return true;
    return false;
  }

  private createEl(e: Entity): HTMLElement {
    const el2 = document.createElement(e.type === "UIButton" ? "button" : "div");
    el2.dataset.entity = e.id;
    Object.assign(el2.style, { position: "absolute", boxSizing: "border-box", display: "flex", alignItems: "center", whiteSpace: "pre-wrap", lineHeight: "1.15", margin: "0" });
    if (e.type === "UIButton") {
      Object.assign(el2.style, { pointerEvents: "auto", border: "none", borderRadius: "12px", cursor: "pointer", justifyContent: "center", fontWeight: "700", touchAction: "manipulation", boxShadow: "0 3px 0 rgba(0,0,0,0.3)", padding: "0 8px", gap: "10px" });
      const fire = () => { this.game.press(e.id); this.game.tapEntity(e.id); };
      el2.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        el2.style.transform = "translateY(2px)";
        if (this.inScroll(e)) return; // fire on click so a drag scrolls the list instead
        ev.preventDefault();
        fire();
      });
      el2.addEventListener("click", (ev) => { ev.stopPropagation(); if (this.inScroll(e)) fire(); });
      const up = () => (el2.style.transform = "");
      el2.addEventListener("pointerup", up);
      el2.addEventListener("pointerleave", up);
      el2.addEventListener("pointercancel", up);
    } else if (e.type === "UIPanel" || e.type === "UIText") {
      if (e.type === "UIPanel") el2.style.borderRadius = "12px";
      if (e.type === "UIText") el2.style.overflow = "visible";
      el2.addEventListener("pointerdown", (ev) => {
        if (e.get<boolean>("input_transparent")) return;
        ev.stopPropagation();
        this.game.tapEntity(e.id);
      });
    }
    return el2;
  }

  private fontFamily(e: Entity): string {
    const f = e.get<string>("font");
    return f && f !== "default" ? FONT_STACKS[f as Theme["font"]] : this.theme.fontFamily;
  }

  private style(n: UINode) {
    const e = n.e, el2 = n.el;
    const off = e.get<number[]>("offset"), size = e.get<number[]>("size");
    let rect: [number, number, number, number];
    const parentUI = e.parent && UI_TYPES.has(e.parent.type) ? e.parent : null;
    if (parentUI) {
      const ps = parentUI.get<number[]>("size");
      rect = uiChildRect(e, ps[0]!, ps[1]!);
    } else {
      const sf = this.safe;
      const W = parseFloat(this.layer.style.width) || 1280, H = parseFloat(this.layer.style.height) || 720;
      rect = anchorRect(e.get<string>("anchor"), off, size, sf.left, sf.top, W - sf.left - sf.right, H - sf.top - sf.bottom);
    }
    el2.style.left = `${rect[0]}px`;
    el2.style.top = `${rect[1]}px`;
    el2.style.width = `${rect[2]}px`;
    el2.style.height = `${rect[3]}px`;
    el2.style.zIndex = String(e.get<number>("z_index") ?? 0);
    const sc = e.get<number[]>("scale") ?? [1, 1];
    el2.style.scale = sc[0] === 1 && sc[1] === 1 ? "" : `${sc[0]} ${sc[1]}`;
    if (e.type === "UIPanel" || e.type === "UIText") {
      const transparent = e.get<boolean>("input_transparent");
      el2.style.pointerEvents = transparent ? "none" : "auto";
    }
    if (e.type === "UIPanel") {
      const scroll = e.get<boolean>("scroll");
      Object.assign(el2.style, scroll
        ? { overflowY: "auto", overflowX: "hidden", touchAction: "pan-y", overscrollBehavior: "contain", webkitOverflowScrolling: "touch", scrollbarWidth: "none", pointerEvents: "auto" }
        : { overflowY: "", overflowX: "", touchAction: "", overflow: e.get<boolean>("clip") ? "hidden" : "" });
      const radius = e.get<number>("radius");
      el2.style.borderRadius = radius >= 0 ? `${radius}px` : this.theme.panel === "pixel" || this.theme.panel === "sharp" ? "0" : "12px";
      // scroll content height: lowest child; a spacer keeps padding at the bottom
      if (scroll) {
        let spacer = el2.querySelector<HTMLElement>(":scope > [data-scroll-spacer]");
        if (!spacer) { spacer = document.createElement("div"); spacer.dataset.scrollSpacer = ""; Object.assign(spacer.style, { position: "absolute", left: "0", width: "1px", height: "1px", pointerEvents: "none" }); el2.appendChild(spacer); }
        let bottom = 0;
        for (const c of e.children) {
          if (!UI_TYPES.has(c.type)) continue;
          if (c.get<boolean>("visible") === false) continue;
          const [, y, , h] = uiChildRect(c, size[0]!, size[1]!);
          bottom = Math.max(bottom, y + h);
        }
        spacer.style.top = `${bottom + 16}px`;
      }
    }
    if (e.type === "UIButton") {
      const icon = e.get<string | undefined>("icon");
      const url = icon ? this.textures.url(icon.replace(/^asset:/, "")) : undefined;
      const text = e.get<string>("text") ?? "";
      const top = e.get<string>("icon_position") === "top";
      el2.replaceChildren();
      el2.style.flexDirection = top ? "column" : "row";
      el2.style.gap = top ? "4px" : "10px";
      if (url) {
        const px = e.get<number>("icon_size") || Math.round(rect[3] * (top ? 0.45 : 0.7));
        const img = document.createElement("div");
        Object.assign(img.style, { width: `${px}px`, height: `${px}px`, flex: "none", backgroundImage: `url("${url}")`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center", imageRendering: this.pixel ? "pixelated" : "auto", pointerEvents: "none" });
        el2.appendChild(img);
      }
      if (text) { const span = document.createElement("span"); span.textContent = text; span.style.pointerEvents = "none"; el2.appendChild(span); }
      el2.style.fontSize = `${e.get<number>("font_size")}px`;
      el2.style.fontFamily = this.fontFamily(e);
      el2.style.color = css(e.get<RGBA>("color"));
    }
    if (e.type === "UIText") {
      el2.textContent = e.get<string>("text") ?? "";
      el2.style.fontSize = `${e.get<number>("font_size")}px`;
      el2.style.fontFamily = this.fontFamily(e);
      el2.style.color = css(e.get<RGBA>("color"));
      if (e.type === "UIText") {
        const align = e.get<string>("align");
        el2.style.justifyContent = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
        const va = e.get<string>("valign");
        el2.style.alignItems = va === "top" ? "flex-start" : va === "bottom" ? "flex-end" : "center";
        el2.style.textAlign = align;
        el2.style.fontWeight = "700";
        el2.style.textShadow = textShadowCss(e.get<RGBA>("outline"), e.get<number>("outline_size"), e.get<RGBA>("shadow"), e.get<number[]>("shadow_offset"), "0 2px 0 rgba(0,0,0,0.45)");
      }
    }
    if (e.type === "UIButton" || e.type === "UIPanel") el2.style.background = css(e.get<RGBA>("background"));
    if (e.type === "UIPanel") {
      const img = e.get<string | undefined>("image");
      const url = img ? this.textures.url(img.replace(/^asset:/, "")) : undefined;
      const tint = e.get<RGBA>("tint");
      const tinted = !!url && (tint[0] < 1 || tint[1] < 1 || tint[2] < 1 || tint[3] < 1);
      // tinted image: a masked child layer multiplies the image by `tint` (the panel fill stays untouched)
      let layer = el2.querySelector<HTMLElement>(":scope > [data-tint-layer]");
      if (tinted) {
        if (!layer) {
          layer = document.createElement("div");
          layer.dataset.tintLayer = "";
          Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", borderRadius: "inherit", zIndex: "-1" });
          el2.prepend(layer);
        }
        const u = `url("${url}")`;
        Object.assign(layer.style, {
          backgroundImage: u, backgroundColor: css([tint[0], tint[1], tint[2], 1]), backgroundBlendMode: "multiply", backgroundSize: "100% 100%",
          opacity: String(tint[3]), maskImage: u, webkitMaskImage: u, maskSize: "100% 100%", webkitMaskSize: "100% 100%", imageRendering: this.pixel ? "pixelated" : "auto",
        } as Partial<CSSStyleDeclaration>);
        el2.style.backgroundImage = "";
        el2.style.isolation = "isolate";
      } else {
        layer?.remove();
        el2.style.backgroundImage = url ? `url("${url}")` : "";
      }
      el2.style.backgroundSize = "100% 100%";
      if (this.pixel) el2.style.imageRendering = "pixelated";
    }
  }

  dispose() { this.root.remove(); }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}
