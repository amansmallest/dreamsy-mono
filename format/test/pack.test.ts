import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Package, PackError, sha256, toHex } from "../src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tool = join(root, "engine/build/release/dreamsy-tool");

const sample = () =>
  Package.fromFiles({
    "dreamsy.toml": 'format = "0"\nname = "T"\n',
    "scenes/main.scene.json": "{}",
    "assets/a.bin": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
    "assets/empty.txt": "",
    "assets/é.txt": "unicode",
    "Z.txt": "upper sorts first",
  });

const u32 = (b: Uint8Array, o: number, val: number) => new DataView(b.buffer, b.byteOffset).setUint32(o, val, true);

describe("sha256", () => {
  it("matches node:crypto for many lengths", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100000]) {
      const d = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
      expect(toHex(sha256(d))).toBe(createHash("sha256").update(d).digest("hex"));
    }
  });
});

describe("Dreamsy pack", () => {
  it("round trips", () => {
    const p = sample();
    const bytes = p.toPack();
    expect(bytes.length % 16).toBe(0);
    const q = Package.fromPack(bytes);
    expect(q.paths()).toEqual(p.paths());
    for (const path of p.paths()) expect(q.bytes(path)).toEqual(p.bytes(path));
    expect(q.toPack()).toEqual(bytes);
    expect(q.contentHash()).toBe(p.contentHash());
    expect(Package.empty().toPack().length).toBe(80);
    expect(Package.fromPack(Package.empty().toPack()).paths()).toEqual([]);
  });

  it("is deterministic regardless of insertion order", () => {
    const p = sample();
    const reversed = Package.fromFiles(Object.fromEntries(p.paths().reverse().map((k) => [k, p.bytes(k)!])));
    expect(reversed.toPack()).toEqual(p.toPack());
    expect(reversed.contentHash()).toBe(p.contentHash());
    expect(p.with("Z.txt", "changed").contentHash()).not.toBe(p.contentHash());
  });

  it("rejects every single-byte corruption", () => {
    const bytes = sample().toPack();
    for (let i = 0; i < bytes.length; i++) {
      const bad = bytes.slice();
      bad[i]! ^= 0x01;
      expect(() => Package.fromPack(bad), `byte ${i}`).toThrow(PackError);
      bad[i] = bytes[i]! ^ 0xff;
      expect(() => Package.fromPack(bad), `byte ${i}`).toThrow(PackError);
    }
  });

  it("skips file hashes only when asked", () => {
    const bad = sample().toPack().slice();
    const dataOffset = Number(new DataView(bad.buffer).getBigUint64(24, true));
    bad[dataOffset]! ^= 1; // first byte of "Z.txt", the first entry in byte order
    expect(() => Package.fromPack(bad)).toThrow(/Z\.txt is corrupt \(hash mismatch\)/);
    expect(Package.fromPack(bad, { verifyHashes: false }).text("Z.txt")).toBe("tpper sorts first");
  });

  it("rejects truncation, extra bytes, bad version and flags", () => {
    const bytes = sample().toPack();
    for (const n of [0, 7, 8, 79, 80, bytes.length - 16, bytes.length - 1])
      expect(() => Package.fromPack(bytes.subarray(0, n))).toThrow(PackError);
    const extra = new Uint8Array(bytes.length + 16);
    extra.set(bytes);
    expect(() => Package.fromPack(extra)).toThrow(/file size does not match/);
    const v2 = bytes.slice();
    u32(v2, 8, 2);
    expect(() => Package.fromPack(v2)).toThrow(/unsupported version 2/);
    const fl = bytes.slice();
    u32(fl, 12, 1);
    expect(() => Package.fromPack(fl)).toThrow(/unknown flags/);
    const many = bytes.slice();
    u32(many, 16, 20001);
    expect(() => Package.fromPack(many)).toThrow(/more than 20000 files/);
    expect(() => Package.fromPack(new TextEncoder().encode("PK\x03\x04 not a pack"))).toThrow(/wrong magic/);
  });

  it("produces the same bytes as the C++ dreamsy-tool for every example and showcase game", async () => {
    if (!existsSync(tool)) {
      console.warn(`skipping C++ cross-check: build ${tool} first`);
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "dpk-"));
    let compared = 0;
    const skipped: string[] = [];
    for (const group of ["games/examples", "games/showcase"]) {
      const base = join(root, group);
      for (const name of readdirSync(base).sort()) {
        const dir = join(base, name);
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, "dreamsy.toml"))) continue;
        const out = join(tmp, `${group.replace("/", "_")}_${name}.dpk`);
        const r = spawnSync(tool, ["pack", dir, out], { encoding: "utf8" });
        if (r.status !== 0) { skipped.push(`${group}/${name}`); continue; } // C++ refuses invalid (e.g. 3D) packages
        const cpp = new Uint8Array(readFileSync(out));
        const pkg = await Package.fromDir(dir);
        expect(Buffer.from(pkg.toPack()).equals(Buffer.from(cpp)), `${group}/${name}`).toBe(true);
        const info = spawnSync(tool, ["info", out], { encoding: "utf8" });
        expect(info.stdout + info.stderr).toContain(pkg.contentHash());
        compared++;
      }
    }
    console.log(`byte-identical with C++: ${compared} packages (skipped: ${skipped.join(", ") || "none"})`);
    expect(compared).toBeGreaterThan(0);
  }, 120_000);
});
