// Per-game save data (save.get / save.set). Core keeps the live table; a SaveHost persists it:
// MemorySaveHost (Node, playtests, tests) or the browser's localStorage host (render/save.ts).
// The host can also forward writes to the app / API for cloud sync later.

export type SaveData = Record<string, unknown>;

/** Max JSON size of one game's whole save table. */
export const MAX_SAVE_BYTES = 64 * 1024;

export interface SaveHost {
  /** Called once at Game.load. */
  load(): SaveData | Promise<SaveData>;
  /** Called after every successful save.set/remove with the full table (hosts debounce). */
  write(data: SaveData): void;
}

/** In-memory save host. Share one instance across Game.load calls to simulate relaunches. */
export class MemorySaveHost implements SaveHost {
  data: SaveData;
  writes = 0;
  constructor(initial: SaveData = {}) { this.data = structuredClone(initial); }
  load(): SaveData { return structuredClone(this.data); }
  write(data: SaveData) { this.data = structuredClone(data); this.writes++; }
}

/** Storage key per game: the platform id when published, else the name. */
export function saveKey(manifest: { id?: string; name: string }): string {
  return `dreamsy.save.${manifest.id ?? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
