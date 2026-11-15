import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/**
 * In-memory game package: posix path → bytes. Immutable; every change returns a new Package.
 * Layout (DREAMSY.MD §3): dreamsy.toml, scenes/, scripts/{client,server,shared}/, data/, assets/.
 */
export class Package {
  private constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  static empty(): Package {
    return new Package(new Map());
  }

  static fromFiles(files: Record<string, Uint8Array | string>): Package {
    const m = new Map<string, Uint8Array>();
    for (const [p, v] of Object.entries(files)) m.set(normalizePath(p), typeof v === "string" ? strToU8(v) : v);
    return new Package(m);
  }

  static fromZip(zip: Uint8Array): Package {
    const raw = unzipSync(zip);
    const files: Record<string, Uint8Array> = {};
    for (const [p, v] of Object.entries(raw)) if (!p.endsWith("/")) files[p] = v;
    // tolerate a single top-level folder wrapping the package
    const tops = new Set(Object.keys(files).map((p) => p.split("/")[0]));
    if (!("dreamsy.toml" in files) && tops.size === 1) {
      const [top] = tops;
      const strip: Record<string, Uint8Array> = {};
      for (const [p, v] of Object.entries(files)) strip[p.slice(top!.length + 1)] = v;
      return Package.fromFiles(strip);
    }
    return Package.fromFiles(files);
  }

  static async fromDir(dir: string): Promise<Package> {
    const files: Record<string, Uint8Array> = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name === ".DS_Store") continue;
      const abs = join(entry.parentPath, entry.name);
      files[relative(dir, abs).split("\\").join("/")] = new Uint8Array(await readFile(abs));
    }
    return Package.fromFiles(files);
  }

  toZip(): Uint8Array {
    // Deterministic: sorted paths, fixed mtime → same content ⇒ same sha256.
    const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
    for (const p of this.paths()) entries[p] = [this.files.get(p)!, { mtime: FIXED_MTIME }];
    return zipSync(entries, { level: 6 });
  }

  async toDir(dir: string): Promise<void> {
    for (const p of this.paths()) {
      const abs = join(dir, p);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, this.files.get(p)!);
    }
  }

  paths(prefix = ""): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  bytes(path: string): Uint8Array | undefined {
    return this.files.get(normalizePath(path));
  }

  text(path: string): string | undefined {
    const b = this.bytes(path);
    return b && strFromU8(b);
  }

  with(path: string, content: Uint8Array | string): Package {
    const m = new Map(this.files);
    m.set(normalizePath(path), typeof content === "string" ? strToU8(content) : content);
    return new Package(m);
  }

  without(path: string): Package {
    const m = new Map(this.files);
    m.delete(normalizePath(path));
    return new Package(m);
  }

  get size(): number {
    let n = 0;
    for (const b of this.files.values()) n += b.byteLength;
    return n;
  }
}

// zip stores local time; a mid-range local date avoids the 1980 lower bound in any timezone
const FIXED_MTIME = new Date(2000, 0, 1);

export class PathError extends Error {}

export function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) throw new PathError(`path escapes package: ${p}`);
  if (parts.length === 0) throw new PathError("empty path");
  return parts.join("/");
}
