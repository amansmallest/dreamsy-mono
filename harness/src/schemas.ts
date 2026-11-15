import Ajv2020Module from "ajv/dist/2020.js";

// ajv ships CJS with a `default` property; normalize across module settings.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (opts: object) => {
  addSchema(s: object): unknown;
  getSchema(id: string): (((v: unknown) => boolean) & { errors?: { instancePath: string; message?: string; params?: object }[] | null }) | undefined;
};
import { expandKits } from "@dreamsy/format";
import { kits } from "./kits.js";

/**
 * Machine-check kit content against the kits' JSON Schemas (engine-web/kits/<kit>/schemas/*.json).
 * Schemas name the files they describe in `title`, e.g. "data/creatures/<id>.json"; that maps package
 * paths to schemas. Files with no matching schema are not checked (returns null).
 */
export interface ContentValidator {
  check(path: string, value: unknown): string[] | null;
  /** How many path patterns are covered (for reports/tests). */
  patterns: string[];
}

const cache = new Map<string, ContentValidator>();

function titleToRegex(title: string): RegExp | null {
  // "data/creatures/<id>.json" | "data/types.json" | "data/story/*.story.txt" (non-json ignored)
  if (!title.startsWith("data/") || !title.endsWith(".json")) return null;
  const esc = title.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>|\*/g, "[^/]+");
  return new RegExp(`^${esc}$`);
}

function pluralize(w: string): string {
  if (/(s|x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

export function contentValidator(kitIds: readonly string[]): ContentValidator {
  const all = expandKits([...kitIds]).sort();
  const key = all.join(",");
  const hit = cache.get(key);
  if (hit) return hit;

  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  const routes: { re: RegExp; id: string; pattern: string }[] = [];
  for (const id of all) {
    const kit = kits().get(id);
    if (!kit) continue;
    for (const [file, schema] of Object.entries(kit.schemas)) {
      const s = schema as { $id?: string; title?: string };
      const sid = s.$id ?? `${id}/${file}`;
      try {
        if (!ajv.getSchema(sid)) ajv.addSchema({ ...s, $id: sid });
      } catch { continue; /* a broken schema shouldn't take the harness down */ }
      const re = s.title ? titleToRegex(s.title) : null;
      if (re) { routes.push({ re, id: sid, pattern: s.title! }); continue; }
      // Fallback by name: card.json / enemy.schema.json → data/cards/<id>.json, data/enemies/<id>.json, data/card.json
      const stem = file.replace(/\.schema\.json$|\.json$/, "");
      if (["common", "defs", "shared"].includes(stem)) continue;
      const plural = pluralize(stem);
      routes.push({ re: new RegExp(`^data/(${plural}|${stem})/[^/]+\\.json$|^data/${stem}\\.json$`), id: sid, pattern: `data/${plural}/<id>.json` });
    }
  }

  const v: ContentValidator = {
    patterns: routes.map((r) => r.pattern),
    check(path, value) {
      const route = routes.find((r) => r.re.test(path));
      if (!route) return null;
      let validate;
      try { validate = ajv.getSchema(route.id); } catch (e) { return [`schema ${route.id} failed to compile: ${(e as Error).message}`]; }
      if (!validate) return null;
      if (validate(value)) return [];
      return (validate.errors ?? []).slice(0, 8).map((e: { instancePath: string; message?: string; params?: object }) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")})` : ""}`);
    },
  };
  cache.set(key, v);
  return v;
}
