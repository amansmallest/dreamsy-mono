/**
 * Kits (DREAMSY.MD §12.1): tested Luau libraries shipped with the engine in kits/<kit>/.
 * A game opts in with `kits = ["rpg"]` in dreamsy.toml and requires them as `require("@kit/rpg")`
 * or `require("@kit/rpg/battle")`. This list is the contract between format, engine and harness.
 */
export const KITS = [
  // foundation (composed by genre kits; games may use them directly)
  "core", "progression", "juice", "combat", "ai", "procgen",
  // wave 1
  "rpg", "platformer", "topdown", "tower-defense", "tycoon",
  // wave 2
  "roguelite", "simulator", "puzzle", "runner", "racing",
  // wave 3
  "story", "deckbuilder", "farming", "survival", "shooter",
] as const;
export type KitId = (typeof KITS)[number];

export const KIT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** `@kit/<kit>` or `@kit/<kit>/<sub>[/<sub>…]` (lowercase). */
export const KIT_REQUIRE_RE = /^@kit\/([a-z][a-z0-9-]{0,31})(?:\/([a-z0-9_\-/]+))?$/;

export const isKit = (id: string): id is KitId => (KITS as readonly string[]).includes(id);

/**
 * Kit dependencies (kit → kits it requires), declared by each kit in kits/<kit>/kit.json.
 * The engine registers the shipped map at load (core/kits.ts); tools can register it too
 * (`registerKitDependencies(...)` with the `requires` lists from each kit.json under kits/, as format/src/cli.ts does). Used by the validator.
 */
let KIT_DEPS: Record<string, readonly string[]> = {};
export function registerKitDependencies(deps: Record<string, readonly string[]>) { KIT_DEPS = { ...deps }; }
export function kitDependencyMap(): Record<string, readonly string[]> { return KIT_DEPS; }

/** Listed kits plus their declared dependencies (transitively), in discovery order. */
export function expandKits(listed: readonly string[], deps: Record<string, readonly string[]> = KIT_DEPS): string[] {
  const out: string[] = [];
  const visit = (k: string) => {
    if (out.includes(k)) return;
    out.push(k);
    for (const d of deps[k] ?? []) visit(d);
  };
  for (const k of listed) visit(k);
  return out;
}
