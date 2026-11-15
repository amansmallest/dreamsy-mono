// JS side of the Luau WASM bridge (see luau/src/bridge.cpp). Works in Node and browsers.
// @ts-ignore — emscripten glue has no types
import createLuau from "./dist/luau.mjs";

export type LuaState = number;

export const LUA_TNIL = 0;
export const LUA_TBOOLEAN = 1;
export const LUA_TLIGHTUSERDATA = 2;
export const LUA_TNUMBER = 3;
export const LUA_TVECTOR = 4;
export const LUA_TSTRING = 5;
export const LUA_TTABLE = 6;
export const LUA_TFUNCTION = 7;

export const LUA_REGISTRYINDEX = -10000;

export interface LuauOptions {
  memoryLimitMB?: number;
  budgetMs?: number;
  /** Provide the wasm bytes directly (otherwise the glue fetches/reads luau.wasm next to luau.mjs). */
  wasmBinary?: Uint8Array;
  /** Override where luau.wasm is fetched from (browser). */
  wasmUrl?: string;
}

/** Called for every `__host(...)` from Luau. Return number of results pushed, or throw. */
export type HostHandler = (L: LuaState) => number;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class LuauVM {
  readonly L: LuaState;
  private scratch = 0;
  private scratchSize = 0;
  private lenPtr: number;
  host: HostHandler = () => 0;

  private constructor(private readonly m: any, opts: LuauOptions) {
    m.hostCall = (L: number) => {
      try {
        return this.host(L);
      } catch (e) {
        this.pushString(L, e instanceof Error ? e.message : String(e));
        return -1;
      }
    };
    this.lenPtr = m._malloc(8);
    this.L = m._dl_init(opts.memoryLimitMB ?? 64, opts.budgetMs ?? 250);
    if (!this.L) throw new Error("failed to create Luau state");
  }

  static async create(opts: LuauOptions = {}): Promise<LuauVM> {
    const args: Record<string, unknown> = {};
    if (opts.wasmBinary) args.wasmBinary = opts.wasmBinary;
    if (opts.wasmUrl) args.locateFile = () => opts.wasmUrl;
    args.print = (s: string) => console.log("[luau]", s);
    args.printErr = (s: string) => console.warn("[luau]", s);
    const m = await createLuau(args);
    return new LuauVM(m, opts);
  }

  // ---- strings in/out ----
  private cstr(s: string): number {
    const need = s.length * 3 + 1;
    if (need > this.scratchSize) {
      if (this.scratch) this.m._free(this.scratch);
      this.scratchSize = Math.max(need, 1024);
      this.scratch = this.m._malloc(this.scratchSize);
    }
    const heap: Uint8Array = this.m.HEAPU8;
    const { written } = enc.encodeInto(s, heap.subarray(this.scratch, this.scratch + this.scratchSize - 1));
    heap[this.scratch + written!] = 0;
    return this.scratch;
  }
  private cstrLen(s: string): [number, number] {
    const p = this.cstr(s);
    const heap: Uint8Array = this.m.HEAPU8;
    let n = 0;
    while (heap[p + n] !== 0) n++;
    return [p, n];
  }

  // ---- core ----
  sandbox(): void { this.m._dl_sandbox(this.L); }
  close(): void { this.m._dl_close(this.L); }
  memUsed(): number { return this.m._dl_mem_used(); }

  /** Compile + load source onto L's stack. Returns null on success, else the error message (popped). */
  load(L: LuaState, chunkname: string, source: string): string | null {
    const name = this.m._malloc(chunkname.length * 3 + 1);
    const heap: Uint8Array = this.m.HEAPU8;
    const { written } = enc.encodeInto(chunkname, heap.subarray(name, name + chunkname.length * 3));
    heap[name + written!] = 0;
    const bytes = enc.encode(source);
    const src = this.m._malloc(bytes.length + 1);
    this.m.HEAPU8.set(bytes, src);
    const status = this.m._dl_load(L, name, src, bytes.length);
    this.m._free(src);
    this.m._free(name);
    if (status !== 0) {
      const msg = this.toString(L, -1) ?? "load failed";
      this.pop(L, 1);
      return msg;
    }
    return null;
  }

  /** New sandboxed thread pushed onto L. */
  newThread(L: LuaState): LuaState {
    const T = this.m._dl_newthread(L);
    if (!T) throw new Error("out of memory creating Luau thread");
    return T;
  }

  /** Protected call. Returns null on success, else {message, traceback} (message popped). */
  pcall(L: LuaState, nargs: number, nresults: number): { message: string; traceback: string } | null {
    const status = this.m._dl_pcall(L, nargs, nresults);
    if (status === 0) return null;
    const message = this.toString(L, -1) ?? "error";
    this.pop(L, 1);
    return { message, traceback: this.m.UTF8ToString(this.m._dl_traceback()) };
  }

  // ---- stack ----
  getTop(L: LuaState): number { return this.m._dl_gettop(L); }
  setTop(L: LuaState, i: number): void { this.m._dl_settop(L, i); }
  pop(L: LuaState, n: number): void { this.m._dl_settop(L, -n - 1); }
  type(L: LuaState, i: number): number { return this.m._dl_type(L, i); }
  isNil(L: LuaState, i: number): boolean { return this.m._dl_type(L, i) <= 0; }
  toNumber(L: LuaState, i: number): number { return this.m._dl_tonumber(L, i); }
  toBoolean(L: LuaState, i: number): boolean { return this.m._dl_toboolean(L, i) !== 0; }
  toString(L: LuaState, i: number): string | null {
    const p = this.m._dl_tolstring(L, i, this.lenPtr);
    if (!p) return null;
    const len = this.m.HEAPU32[this.lenPtr >> 2];
    return dec.decode(this.m.HEAPU8.subarray(p, p + len));
  }
  /** tostring() with __tostring; leaves nothing on the stack. */
  toDisplayString(L: LuaState, i: number): string {
    const p = this.m._dl_tostring_meta(L, i, this.lenPtr);
    const len = this.m.HEAPU32[this.lenPtr >> 2];
    const s = dec.decode(this.m.HEAPU8.subarray(p, p + len));
    this.pop(L, 1);
    return s;
  }
  pushNil(L: LuaState): void { this.m._dl_pushnil(L); }
  pushNumber(L: LuaState, n: number): void { this.m._dl_pushnumber(L, n); }
  pushBoolean(L: LuaState, b: boolean): void { this.m._dl_pushboolean(L, b ? 1 : 0); }
  pushString(L: LuaState, s: string): void {
    const [p, n] = this.cstrLen(s);
    this.m._dl_pushlstring(L, p, n);
  }
  pushValue(L: LuaState, i: number): void { this.m._dl_pushvalue(L, i); }
  remove(L: LuaState, i: number): void { this.m._dl_remove(L, i); }
  insert(L: LuaState, i: number): void { this.m._dl_insert(L, i); }
  ref(L: LuaState, i: number): number { return this.m._dl_ref(L, i); }
  getRef(L: LuaState, ref: number): void { this.m._dl_getref(L, ref); }
  unref(L: LuaState, ref: number): void { this.m._dl_unref(L, ref); }
  getGlobal(L: LuaState, k: string): void { this.m._dl_getglobal(L, this.cstr(k)); }
  setGlobal(L: LuaState, k: string): void { this.m._dl_setglobal(L, this.cstr(k)); }
  rawGetField(L: LuaState, i: number, k: string): void { this.m._dl_rawgetfield(L, i, this.cstr(k)); }
  rawSetField(L: LuaState, i: number, k: string): void { this.m._dl_rawsetfield(L, i, this.cstr(k)); }
  rawGetI(L: LuaState, i: number, n: number): void { this.m._dl_rawgeti(L, i, n); }
  rawSetI(L: LuaState, i: number, n: number): void { this.m._dl_rawseti(L, i, n); }
  createTable(L: LuaState, narr = 0, nrec = 0): void { this.m._dl_createtable(L, narr, nrec); }
  objLen(L: LuaState, i: number): number { return this.m._dl_objlen(L, i); }
  next(L: LuaState, i: number): boolean { return this.m._dl_next(L, i) !== 0; }
  xmove(from: LuaState, to: LuaState, n: number): void { this.m._dl_xmove(from, to, n); }
}
