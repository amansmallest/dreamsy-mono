import { stringify as stringifyToml, parse as parseToml } from "smol-toml";
import { z } from "zod";
import { Package, PathError, normalizePath } from "./package.js";
import { AssetMeta, FORMAT_VERSION, Id, Scene, ScriptPath, type Entity } from "./schema.js";

/**
 * Edit ops (DREAMSY.MD §3.3). The harness and in-app edits both speak this language.
 * Ops address entities by id only — ids are unique across the package, so the scene is implied.
 * A batch applies all-or-nothing; run validatePackage() on the result before committing.
 */

const Props = z.record(z.string(), z.unknown());
const TextPath = z.string().regex(/^(notes\.md|scripts\/(client|server|shared)\/[a-z0-9_\-/]+\.luau|data\/[a-z0-9_\-/]+\.(luau|json)|data\/[a-z0-9_\-/]+\.txt)$/,
  "text files are notes.md, scripts/{client,server,shared}/*.luau, data/*.luau|json (tilesets: data/tilesets/*.json) or data/**/*.txt (levels, rooms, chunks)");
const ScenePath = z.string().regex(/^scenes\/[a-z0-9_\-/]+\.scene\.json$/);

export const Op = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set_manifest"), key: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/), value: z.unknown() }),
  z.strictObject({ op: z.literal("add_scene"), scene: ScenePath, root: z.strictObject({ id: Id, type: z.string(), name: z.string().optional(), props: Props.optional() }) }),
  z.strictObject({ op: z.literal("remove_scene"), scene: ScenePath }),
  z.strictObject({
    op: z.literal("add_entity"),
    parent: Id,
    id: Id,
    type: z.string(),
    name: z.string().optional(),
    props: Props.optional(),
    scripts: z.array(ScriptPath).optional(),
    tags: z.array(z.string()).optional(),
    /** Position among siblings; default = last. */
    index: z.number().int().min(0).optional(),
  }),
  /** Merge props; a null value resets that prop to its default. */
  z.strictObject({ op: z.literal("set_props"), id: Id, props: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    op: z.literal("update_entity"),
    id: Id,
    type: z.string().optional(),
    name: z.string().nullable().optional(),
    scripts: z.array(ScriptPath).optional(),
    tags: z.array(z.string()).optional(),
  }),
  /** Removes the entity and its whole subtree. */
  z.strictObject({ op: z.literal("remove_entity"), id: Id }),
  z.strictObject({ op: z.literal("move_entity"), id: Id, parent: Id, index: z.number().int().min(0).optional() }),
  z.strictObject({ op: z.literal("write_file"), path: TextPath, content: z.string() }),
  /** Exact search/replace; `old` must occur exactly once. */
  z.strictObject({ op: z.literal("edit_file"), path: TextPath, old: z.string().min(1), new: z.string() }),
  z.strictObject({ op: z.literal("delete_file"), path: TextPath }),
  /** Binary comes from `blobs[blob]` passed to applyOps (models never emit bytes). */
  z.strictObject({ op: z.literal("put_asset"), id: Id, blob: z.string(), meta: AssetMeta }),
  z.strictObject({ op: z.literal("remove_asset"), id: Id }),
]);
export type Op = z.infer<typeof Op>;
export const OpBatch = z.array(Op).min(1).max(500);

export class OpError extends Error {
  constructor(readonly index: number, readonly op: Op | unknown, message: string) {
    super(`op #${index}${op && typeof op === "object" && "op" in op ? ` (${(op as Op).op})` : ""}: ${message}`);
  }
}

/** Parse untrusted (model) output into ops; throws OpError with the first bad index. */
export function parseOps(raw: unknown): Op[] {
  if (!Array.isArray(raw)) throw new OpError(-1, null, "ops must be an array");
  return raw.map((o, i) => {
    const r = Op.safeParse(o);
    if (!r.success) throw new OpError(i, o, r.error.issues.map((x) => `${x.path.join(".") || "op"}: ${x.message}`).join("; "));
    return r.data;
  });
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export function applyOps(pkg: Package, ops: Op[], blobs: Record<string, Uint8Array> = {}): Package {
  const st = new State(pkg);
  ops.forEach((op, i) => {
    try {
      st.apply(op, blobs);
    } catch (e) {
      if (e instanceof OpError) throw e;
      if (e instanceof Fail || e instanceof PathError) throw new OpError(i, op, e.message);
      throw e;
    }
  });
  return st.commit();
}

class Fail extends Error {}
const fail = (m: string): never => { throw new Fail(m); };

/** Mutable working copy: scenes parsed once, serialized at commit. */
class State {
  private scenes = new Map<string, Scene>();
  private dirty = new Set<string>();

  constructor(private pkg: Package) {
    for (const p of pkg.paths("scenes/")) {
      if (!p.endsWith(".scene.json")) continue;
      try {
        this.scenes.set(p, Scene.parse(JSON.parse(pkg.text(p)!)));
      } catch {
        // invalid scenes stay as raw text; ops that touch them will fail to find ids
      }
    }
  }

  commit(): Package {
    let pkg = this.pkg;
    for (const p of this.dirty) {
      const s = this.scenes.get(p);
      pkg = s ? pkg.with(p, json(s)) : pkg.without(p);
    }
    return pkg;
  }

  private locate(id: string): { file: string; scene: Scene; entity: Entity } | undefined {
    for (const [file, scene] of this.scenes) {
      const entity = scene.entities[id];
      if (entity) return { file, scene, entity };
    }
    return undefined;
  }

  private must(id: string) {
    return this.locate(id) ?? fail(`entity "${id}" does not exist`);
  }

  private parentOf(scene: Scene, id: string): string | undefined {
    for (const [pid, e] of Object.entries(scene.entities)) if (e.children?.includes(id)) return pid;
    return undefined;
  }

  private insertChild(parent: Entity, id: string, index?: number) {
    const kids = parent.children ?? [];
    kids.splice(index === undefined ? kids.length : Math.min(index, kids.length), 0, id);
    parent.children = kids;
  }

  private detach(scene: Scene, id: string) {
    const pid = this.parentOf(scene, id);
    if (!pid) return;
    const p = scene.entities[pid]!;
    p.children = p.children!.filter((c) => c !== id);
    if (p.children.length === 0) delete p.children;
  }

  apply(op: Op, blobs: Record<string, Uint8Array>) {
    switch (op.op) {
      case "set_manifest": {
        const text = this.pkg.text("dreamsy.toml") ?? `format = "${FORMAT_VERSION}"\n`;
        let doc: Record<string, unknown>;
        try { doc = parseToml(text) as Record<string, unknown>; } catch (e) { return fail(`dreamsy.toml is not valid TOML: ${(e as Error).message}`); }
        const keys = op.key.split(".");
        let cur = doc;
        for (const k of keys.slice(0, -1)) {
          if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
          cur = cur[k] as Record<string, unknown>;
        }
        const last = keys.at(-1)!;
        if (op.value === null) delete cur[last];
        else cur[last] = op.value;
        this.pkg = this.pkg.with("dreamsy.toml", stringifyToml(doc) + "\n");
        return;
      }

      case "add_scene": {
        const file = normalizePath(op.scene);
        if (this.scenes.has(file) || this.pkg.has(file)) fail(`${file} already exists`);
        if (this.locate(op.root.id)) fail(`id "${op.root.id}" already exists`);
        const root: Entity = { type: op.root.type };
        if (op.root.name) root.name = op.root.name;
        if (op.root.props) root.props = op.root.props;
        this.scenes.set(file, { format: FORMAT_VERSION, root: op.root.id, entities: { [op.root.id]: root } });
        this.dirty.add(file);
        return;
      }

      case "remove_scene": {
        const file = normalizePath(op.scene);
        if (!this.scenes.has(file)) fail(`${file} does not exist`);
        this.scenes.delete(file);
        this.dirty.add(file);
        return;
      }

      case "add_entity": {
        if (this.locate(op.id)) fail(`id "${op.id}" already exists; pick a new unique id`);
        const { file, scene, entity: parent } = this.must(op.parent);
        const e: Entity = { type: op.type };
        if (op.name) e.name = op.name;
        if (op.props && Object.keys(op.props).length) e.props = op.props;
        if (op.scripts?.length) e.scripts = op.scripts;
        if (op.tags?.length) e.tags = op.tags;
        scene.entities[op.id] = e;
        this.insertChild(parent, op.id, op.index);
        this.dirty.add(file);
        return;
      }

      case "set_props": {
        const { file, entity } = this.must(op.id);
        const props = { ...(entity.props ?? {}) };
        for (const [k, v] of Object.entries(op.props)) {
          if (v === null) delete props[k];
          else props[k] = v;
        }
        if (Object.keys(props).length) entity.props = props;
        else delete entity.props;
        this.dirty.add(file);
        return;
      }

      case "update_entity": {
        const { file, entity } = this.must(op.id);
        if (op.type !== undefined) entity.type = op.type;
        if (op.name === null) delete entity.name;
        else if (op.name !== undefined) entity.name = op.name;
        if (op.scripts !== undefined) { if (op.scripts.length) entity.scripts = op.scripts; else delete entity.scripts; }
        if (op.tags !== undefined) { if (op.tags.length) entity.tags = op.tags; else delete entity.tags; }
        this.dirty.add(file);
        return;
      }

      case "remove_entity": {
        const { file, scene } = this.must(op.id);
        if (scene.root === op.id) fail(`"${op.id}" is the scene root; use remove_scene`);
        this.detach(scene, op.id);
        const stack = [op.id];
        while (stack.length) {
          const id = stack.pop()!;
          stack.push(...(scene.entities[id]?.children ?? []));
          delete scene.entities[id];
        }
        this.dirty.add(file);
        return;
      }

      case "move_entity": {
        const src = this.must(op.id);
        const dst = this.must(op.parent);
        if (src.file !== dst.file) fail(`"${op.id}" and "${op.parent}" are in different scenes`);
        if (src.scene.root === op.id) fail(`cannot move the scene root`);
        // reject moving under own subtree
        for (let p: string | undefined = op.parent; p; p = this.parentOf(src.scene, p)) {
          if (p === op.id) fail(`cannot move "${op.id}" under its own descendant "${op.parent}"`);
        }
        this.detach(src.scene, op.id);
        this.insertChild(dst.entity, op.id, op.index);
        this.dirty.add(src.file);
        return;
      }

      case "write_file":
        this.pkg = this.pkg.with(op.path, op.content);
        return;

      case "edit_file": {
        const text = this.pkg.text(op.path) ?? fail(`${op.path} does not exist`);
        const first = text.indexOf(op.old);
        if (first < 0) fail(`text to replace not found in ${op.path}`);
        if (text.indexOf(op.old, first + 1) >= 0) fail(`text to replace occurs more than once in ${op.path}; include more context`);
        this.pkg = this.pkg.with(op.path, text.slice(0, first) + op.new + text.slice(first + op.old.length));
        return;
      }

      case "delete_file":
        if (!this.pkg.has(op.path)) fail(`${op.path} does not exist`);
        this.pkg = this.pkg.without(op.path);
        return;

      case "put_asset": {
        const bytes = blobs[op.blob] ?? fail(`blob "${op.blob}" was not provided`);
        if (!op.meta.file.startsWith(`${op.id}.`)) fail(`meta.file must be "${op.id}.<ext>"`);
        const oldMeta = this.pkg.text(`assets/${op.id}.meta.json`);
        if (oldMeta) {
          try {
            const old = AssetMeta.parse(JSON.parse(oldMeta));
            if (old.file !== op.meta.file) this.pkg = this.pkg.without(`assets/${old.file}`);
          } catch { /* replacing a broken meta */ }
        }
        this.pkg = this.pkg.with(`assets/${op.meta.file}`, bytes).with(`assets/${op.id}.meta.json`, json(op.meta));
        return;
      }

      case "remove_asset": {
        const metaPath = `assets/${op.id}.meta.json`;
        const metaText = this.pkg.text(metaPath) ?? fail(`asset "${op.id}" does not exist`);
        try {
          const meta = AssetMeta.parse(JSON.parse(metaText));
          this.pkg = this.pkg.without(`assets/${meta.file}`);
        } catch { /* broken meta: still remove it */ }
        this.pkg = this.pkg.without(metaPath);
        return;
      }
    }
  }
}
