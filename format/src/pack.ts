// Dreamsy pack (.dpk) reader and writer — docs/format.md §3.6. Byte-identical with engine/src/pkg/pack.cpp:
// the writer emits one canonical layout and the reader accepts only that layout.
import { sha256 } from "./sha256.js";

const MAGIC = [0x44, 0x52, 0x45, 0x41, 0x4d, 0x53, 0x59, 0x1a]; // "DREAMSY" 0x1A
const VERSION = 1;
const HEADER = 80;
const ENTRY_FIXED = 2 + 1 + 1 + 8 + 8 + 32;

export const PACK_LIMITS = {
  maxFiles: 20000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPathBytes: 1024,
} as const;

export class PackError extends Error {}

const align16 = (n: number) => Math.ceil(n / 16) * 16;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

interface Entry { path: Uint8Array; data: Uint8Array }

/** Entries sorted by UTF-8 byte order (as the C++ std::map), ready to serialize. */
function sortedEntries(files: ReadonlyMap<string, Uint8Array>): Entry[] {
  return [...files].map(([p, data]) => ({ path: enc.encode(p), data })).sort((a, b) => cmpBytes(a.path, b.path));
}

function buildIndex(entries: Entry[]): Uint8Array {
  let size = 0;
  for (const e of entries) {
    if (e.path.length > 0xffff) throw new PackError(`path too long for a pack: ${dec.decode(e.path)}`);
    size += ENTRY_FIXED + e.path.length;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0, offset = 0;
  for (const e of entries) {
    v.setUint16(o, e.path.length, true); o += 2;
    out.set(e.path, o); o += e.path.length;
    o += 2; // compression none, reserved
    v.setBigUint64(o, BigInt(offset), true); o += 8;
    v.setBigUint64(o, BigInt(e.data.length), true); o += 8;
    out.set(sha256(e.data), o); o += 32;
    offset = align16(offset + e.data.length);
  }
  return out;
}

export function packIndexHash(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return sha256(buildIndex(sortedEntries(files)));
}

export function writePack(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries = sortedEntries(files);
  const index = buildIndex(entries);
  const dataOffset = align16(HEADER + index.length);
  let dataSize = 0;
  for (const e of entries) dataSize = align16(dataSize + e.data.length);
  const out = new Uint8Array(dataOffset + dataSize);
  const v = new DataView(out.buffer);
  out.set(MAGIC, 0);
  v.setUint32(8, VERSION, true);
  v.setUint32(12, 0, true);
  v.setUint32(16, entries.length, true);
  v.setUint32(20, index.length, true);
  v.setBigUint64(24, BigInt(dataOffset), true);
  v.setBigUint64(32, BigInt(dataSize), true);
  out.set(sha256(index), 40);
  out.set(index, HEADER);
  let o = dataOffset;
  for (const e of entries) { out.set(e.data, o); o = dataOffset + align16(o - dataOffset + e.data.length); }
  return out;
}

/** Parses and strictly validates a pack. File views alias `bytes` (no copies). */
export function readPack(bytes: Uint8Array, opts: { verifyHashes?: boolean } = {}): Map<string, Uint8Array> {
  const verify = opts.verifyHashes ?? true;
  const L = PACK_LIMITS;
  const bad = (why: string) => new PackError(`not a valid Dreamsy pack: ${why}`);
  const size = bytes.length;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (o: number) => Number(v.getBigUint64(o, true)); // exact up to 2^53; larger values fail the checks below

  if (size < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw bad("wrong magic bytes");
  if (size < HEADER) throw bad("truncated header");
  const version = v.getUint32(8, true);
  const flags = v.getUint32(12, true);
  const count = v.getUint32(16, true);
  const indexSize = v.getUint32(20, true);
  const dataOffset = u64(24);
  const dataSize = u64(32);
  if (version !== VERSION) throw bad(`unsupported version ${version} (this reader reads version 1)`);
  if (flags !== 0) throw bad("unknown flags");
  for (let i = 72; i < 80; i++) if (bytes[i] !== 0) throw bad("reserved header bytes are not zero");
  if (count > L.maxFiles) throw bad(`more than ${L.maxFiles} files`);
  if (dataSize > L.maxTotalBytes + count * 16) throw bad(`larger than ${L.maxTotalBytes} bytes`);
  if (indexSize > size - HEADER || indexSize < count * ENTRY_FIXED) throw bad("bad index size");
  if (dataOffset !== align16(HEADER + indexSize)) throw bad("bad data offset");
  if (dataOffset > size || dataSize !== size - dataOffset) throw bad("file size does not match the header");
  for (let i = HEADER + indexSize; i < dataOffset; i++) if (bytes[i] !== 0) throw bad("non-zero padding after the index");

  const index = bytes.subarray(HEADER, HEADER + indexSize);
  const want = bytes.subarray(40, 72);
  if (cmpBytes(sha256(index), want) !== 0) throw bad("index hash mismatch");

  const files = new Map<string, Uint8Array>();
  let pos = HEADER;
  const end = HEADER + indexSize;
  let prev: Uint8Array | undefined;
  let expected = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (end - pos < 2) throw bad("truncated index");
    const pathLen = v.getUint16(pos, true);
    if (end - pos < ENTRY_FIXED + pathLen) throw bad("truncated index");
    const pathBytes = bytes.subarray(pos + 2, pos + 2 + pathLen);
    pos += 2 + pathLen;
    const compression = bytes[pos]!, reserved = bytes[pos + 1]!;
    const offset = u64(pos + 2), fileSize = u64(pos + 10);
    const hash = bytes.subarray(pos + 18, pos + 50);
    pos += 50;

    let path: string;
    try { path = dec.decode(pathBytes); } catch { throw bad(`entry ${i} has a non-UTF-8 path`); }
    if (!isCanonical(path) || cmpBytes(enc.encode(path), pathBytes) !== 0) throw bad(`entry ${i} has a non-canonical path ${JSON.stringify(path)}`);
    if (prev && cmpBytes(prev, pathBytes) >= 0) throw bad(`paths are not strictly ascending at ${JSON.stringify(path)}`);
    if (compression !== 0) throw bad(`${path} uses an unsupported compression (${compression})`);
    if (reserved !== 0) throw bad(`${path} has non-zero reserved bytes`);
    if (offset !== expected) throw bad(`${path} is not at its canonical offset`);
    if (fileSize > dataSize || offset > dataSize - fileSize) throw bad(`${path} is out of bounds`);
    const start = dataOffset + offset;
    const data = bytes.subarray(start, start + fileSize);
    const padEnd = Math.min(align16(offset + fileSize), dataSize);
    for (let k = offset + fileSize; k < padEnd; k++) if (bytes[dataOffset + k] !== 0) throw bad(`non-zero padding after ${path}`);
    if (verify && cmpBytes(sha256(data), hash) !== 0) throw bad(`${path} is corrupt (hash mismatch)`);
    if (pathBytes.length > L.maxPathBytes) throw new PackError(`path longer than ${L.maxPathBytes} bytes`);
    if (fileSize > L.maxFileBytes) throw new PackError(`${path} is ${fileSize} bytes; max ${L.maxFileBytes}`);
    total += fileSize;
    if (total > L.maxTotalBytes) throw new PackError(`package is larger than ${L.maxTotalBytes} bytes`);
    files.set(path, data);
    prev = pathBytes;
    expected = align16(offset + fileSize);
  }
  if (pos !== end) throw bad("extra bytes after the index");
  if (expected !== dataSize) throw bad("data size does not match the entries");
  return files;
}

/** True when `p` is already in normalizePath form (no "\", empty, "." or ".." segments). */
function isCanonical(p: string): boolean {
  if (p.length === 0 || p.includes("\\")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
