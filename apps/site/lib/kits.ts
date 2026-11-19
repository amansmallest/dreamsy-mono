import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GAMES, KITS, type Game, type Kit } from "./content";

const KITS_DIR = join(process.cwd(), "..", "..", "kits");

export type Block = { kind: "p"; text: string } | { kind: "ul"; items: string[] } | { kind: "code"; lang: string; code: string };

export interface KitPage extends Kit {
  intro: Block[];
  setup: Block[];
  sections: string[];
  modules: string[];
  schemas: string[];
  requires: string[];
  usedBy: string[];
  example?: Game;
}

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ").trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      out.push({ kind: "code", lang, code: code.join("\n") });
    } else if (/^\s*- /.test(line)) {
      flush();
      const items = [line.replace(/^\s*- /, "")];
      while (i + 1 < lines.length && lines[i + 1]!.trim() && !lines[i + 1]!.startsWith("```")) {
        const nextLine = lines[++i]!;
        if (/^\s*- /.test(nextLine)) items.push(nextLine.replace(/^\s*- /, ""));
        else items[items.length - 1] += " " + nextLine.trim();
      }
      out.push({ kind: "ul", items });
    } else if (!line.trim()) flush();
    else if (!line.startsWith("#")) para.push(line.trim());
  }
  flush();
  return out;
}

function section(md: string, title: string) {
  const re = new RegExp(`^## ${title}\\s*$`, "m");
  const m = re.exec(md);
  if (!m) return "";
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

const requiresOf = (id: string): string[] => {
  try {
    return JSON.parse(readFileSync(join(KITS_DIR, id, "kit.json"), "utf8")).requires ?? [];
  } catch {
    return [];
  }
};

export function loadKit(id: string): KitPage {
  const kit = KITS.find((k) => k.id === id)!;
  const dir = join(KITS_DIR, id);
  const md = readFileSync(join(dir, "KIT.md"), "utf8");
  const firstSection = md.search(/^## /m);
  const intro = blocks(firstSection < 0 ? md : md.slice(0, firstSection)).slice(0, 4);
  const setup = blocks(section(md, "Setup")).slice(0, 4);
  const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 14);
  const modules = readdirSync(dir).filter((f) => f.endsWith(".luau")).map((f) => f.replace(/\.luau$/, "")).sort((a, b) => (a === "init" ? -1 : b === "init" ? 1 : a.localeCompare(b)));
  const schemasDir = join(dir, "schemas");
  const schemas = existsSync(schemasDir) ? readdirSync(schemasDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
  const usedBy = KITS.filter((k) => requiresOf(k.id).includes(id)).map((k) => k.id);
  const example = GAMES.find((g) => g.id === `kit-${id}`);
  return { ...kit, intro, setup, sections, modules, schemas, requires: requiresOf(id), usedBy, example };
}
