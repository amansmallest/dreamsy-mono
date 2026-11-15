import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Package, validatePackage } from "@dreamsy/format";

/**
 * Kit templates: every genre kit ships a small, working, tested example game
 * (games/examples/kit-<kit>). New games start FROM it by default — Opus reskins and rebuilds
 * content on proven systems instead of starting from an empty package, so the first playable
 * version lands in minutes. "from scratch" in the prompt opts out (router sets fromScratch).
 */
const EXAMPLES = fileURLToPath(new URL("../../games/examples/", import.meta.url));

/** Genre kits only — foundation kits have no game-shaped template. */
const FOUNDATION = new Set(["core", "progression", "juice", "combat", "ai", "procgen"]);

const cache = new Map<string, Package | null>();

export async function kitTemplate(kits: readonly string[]): Promise<{ kit: string; pkg: Package } | null> {
  for (const kit of kits) {
    if (FOUNDATION.has(kit)) continue;
    if (!cache.has(kit)) {
      const dir = `${EXAMPLES}kit-${kit}`;
      let pkg: Package | null = null;
      if (existsSync(`${dir}/dreamsy.toml`)) {
        try {
          const p = await Package.fromDir(dir);
          pkg = validatePackage(p).ok ? p : null; // never start from a broken template
        } catch { pkg = null; }
      }
      cache.set(kit, pkg);
    }
    const pkg = cache.get(kit);
    if (pkg) return { kit, pkg };
  }
  return null;
}

export function templateNote(kit: string): string {
  return [
    `You are starting from the "${kit}" KIT TEMPLATE: a small, working, tested ${kit} game already in the package (scenes, scripts, data, sprites). Its systems work — keep them.`,
    "Turn it into the player's game, fast, in this order:",
    "1. FIRST PLAYABLE (this round, quickly): set_manifest name/description/style/palette for the player's game; rewrite the title scene; replace the template's characters, setting, enemies/items/levels data and sprites with the player's theme (edit data/*.json + draw_sprite; build_content for bulk); delete template content that doesn't fit. Playtest once, then finish — the player gets this version in minutes.",
    "2. Write notes.md as the bible for THEIR game (not the template's) with milestones for growing it into a 1–2 hour game; later rounds continue from it.",
    "Never leave template names, art or text visible in the final game.",
  ].join("\n");
}
