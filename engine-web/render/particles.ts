// Particles2D drawing: one instanced quad mesh per emitter (world space), colors/sizes interpolated
// from the entity props by particle age. Simulation lives in core/particles.ts.
import * as THREE from "three";
import type { Entity, RGBA } from "../core/index.js";
import type { TextureCache } from "./textures.js";

const VERT = /* glsl */ `
attribute vec4 iPos;   // x, y, size, unused
attribute vec4 iColor; // linear rgba
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = iColor;
  vUv = vec2(uv.x, 1.0 - uv.y);
  vec2 p = position.xy * iPos.z + iPos.xy; // parent group flips y (world +y is down)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float useMap;
uniform float circle;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vec4 c = vColor;
  if (useMap > 0.5) c *= texture2D(map, vUv);
  else if (circle > 0.5) {
    vec2 d = vUv - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    c.a *= clamp((0.5 - r) * 24.0, 0.0, 1.0);
  }
  if (c.a <= 0.003) discard;
  gl_FragColor = c;
  #include <colorspace_fragment>
}`;

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

export class ParticlesView {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private cap = 0;
  private pos!: THREE.InstancedBufferAttribute;
  private col!: THREE.InstancedBufferAttribute;
  private texRef: string | undefined = undefined;

  constructor(private textures: TextureCache, private pixel: boolean) {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute("position", base.attributes.position!);
    g.setAttribute("uv", base.attributes.uv!);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { map: { value: null }, useMap: { value: 0 }, circle: { value: 0 } },
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.ensure(64);
  }

  private ensure(n: number) {
    if (n <= this.cap) return;
    let cap = Math.max(64, this.cap);
    while (cap < n) cap *= 2;
    this.cap = cap;
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute("iPos", this.pos);
    this.mesh.geometry.setAttribute("iColor", this.col);
  }

  sync(e: Entity, renderOrder: number, visible: boolean) {
    const em = e.emitter;
    const n = em?.n ?? 0;
    this.mesh.visible = visible && n > 0;
    this.mesh.renderOrder = renderOrder;
    if (!em || n === 0) return;
    this.ensure(n);
    const c0 = e.get<RGBA>("start_color"), c1 = e.get<RGBA>("end_color");
    const s0 = e.get<number>("start_size"), s1 = e.get<number>("end_size");
    const P = this.pos.array as Float32Array, C = this.col.array as Float32Array;
    const snap = this.pixel;
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, em.age[i]! / em.life[i]!);
      const size = s0 + (s1 - s0) * t;
      P[i * 4] = snap ? Math.round(em.x[i]!) : em.x[i]!;
      P[i * 4 + 1] = snap ? Math.round(em.y[i]!) : em.y[i]!;
      P[i * 4 + 2] = snap ? Math.max(1, Math.round(size)) : size;
      for (let k = 0; k < 3; k++) C[i * 4 + k] = toLinear(c0[k]! + (c1[k]! - c0[k]!) * t);
      C[i * 4 + 3] = c0[3] + (c1[3] - c0[3]) * t;
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.pos.addUpdateRange(0, n * 4);
    this.col.addUpdateRange(0, n * 4);
    this.mesh.geometry.instanceCount = n;
    const u = this.mesh.material.uniforms;
    u.circle!.value = e.get<string>("shape") === "circle" ? 1 : 0;
    const ref = e.get<string | undefined>("texture");
    if (ref !== this.texRef || (ref && !u.map!.value)) {
      const tex = ref ? this.textures.get(ref, Math.max(s0, s1) * 2) : null;
      u.map!.value = tex ?? null;
      u.useMap!.value = tex ? 1 : 0;
      if (tex !== undefined) this.texRef = ref;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
