// Lighting2D darkness overlay: one full-view quad drawn after the world (before `emissive` things) that
// multiplies the frame by the light level: ambient-tinted darkness + up to 64 Light2D holes + vignette.
// Single pass, no render targets: the fragment loop stops at the live light count (cheap on phones).
import * as THREE from "three";
import { collectLights, lightingState, MAX_LIGHTS, type Entity, type Game } from "../core/index.js";

/** Draw order: world < overlay < emissive (renderOrder). */
export const OVERLAY_ORDER = 2e9;
export const EMISSIVE_BASE = 3e9;

const VERT = /* glsl */ `
varying vec2 vWorld;
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = vec2(w.x, -w.y); // scene y is flipped; lights are in world (+y down)
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
#define MAX_LIGHTS ${MAX_LIGHTS}
uniform vec3 uBase;
uniform vec4 uView;               // view center x, y, visible w, h (world px)
uniform float uVignette;
uniform int uCount;
uniform vec4 uLight[MAX_LIGHTS];   // x, y, radius, falloff
uniform vec3 uColor[MAX_LIGHTS];   // color * intensity
varying vec2 vWorld;
varying vec2 vUv;
void main() {
  vec3 light = uBase;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uCount) break;
    vec4 L = uLight[i];
    float d = distance(vWorld, L.xy);
    if (d < L.z) light += uColor[i] * pow(1.0 - d / L.z, L.w);
  }
  if (uVignette > 0.0) {
    float r = length((vWorld - uView.xy) / uView.zw) * 1.4142 * 2.0;
    light *= 1.0 - uVignette * smoothstep(0.35, 1.0, r);
  }
  gl_FragColor = vec4(min(light, vec3(1.0)), 1.0);
}`;

export class LightingOverlay {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private uniforms = {
    uBase: { value: new THREE.Vector3(1, 1, 1) },
    uVignette: { value: 0 },
    uView: { value: new THREE.Vector4(0, 0, 1, 1) },
    uCount: { value: 0 },
    uLight: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
    uColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  };
  /** Light2D entities, rebuilt when the world structure changes. */
  private lights: Entity[] = [];
  private rev = -1;
  active = false;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false,
      // frame = frame * light
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = OVERLAY_ORDER;
    this.mesh.frustumCulled = false;
  }

  /** Update for this frame; view center (cx, cy) and visible world size (w, h). Returns whether darkness is on. */
  sync(game: Game, cx: number, cy: number, w: number, h: number): boolean {
    const st = lightingState(game);
    this.active = !!st;
    this.mesh.visible = this.active;
    if (!st) return false;
    if (game.world.structureRev !== this.rev) {
      this.rev = game.world.structureRev;
      this.lights = [];
      for (const e of game.world.walk()) if (e.type === "Light2D") this.lights.push(e);
    }
    const u = this.uniforms;
    u.uBase.value.set(...(st.ambient.map((a) => 1 - st.darkness + st.darkness * a) as [number, number, number]));
    u.uVignette.value = st.vignette;
    u.uView.value.set(cx, cy, Math.max(1, w), Math.max(1, h));
    const ls = collectLights(game, cx, cy, this.lights);
    u.uCount.value = ls.length;
    ls.forEach((l, i) => {
      u.uLight.value[i]!.set(l.x, l.y, Math.max(1e-3, l.radius), l.falloff);
      u.uColor.value[i]!.set(l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity);
    });
    // a little bigger than the view (camera shake, pixel snapping)
    this.mesh.position.set(cx, -cy, 0);
    this.mesh.scale.set(w * 1.1 + 8, h * 1.1 + 8, 1);
    return true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
