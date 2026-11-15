// Browser save host: one localStorage entry per game (key from core saveKey), debounced writes,
// flushed when the page hides. `onWrite` lets the app/API mirror saves for cloud sync later.
import type { SaveData, SaveHost } from "../core/index.js";

export class LocalStorageSaveHost implements SaveHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: SaveData | null = null;

  constructor(readonly key: string, private onWrite?: (data: SaveData) => void, private delayMs = 300) {
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.flush);
      document.addEventListener("visibilitychange", this.flush);
    }
  }

  load(): SaveData {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? "null");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  write(data: SaveData) {
    this.latest = data;
    this.timer ??= setTimeout(this.flush, this.delayMs);
  }

  flush = () => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const d = this.latest;
    if (!d) return;
    this.latest = null;
    try { localStorage.setItem(this.key, JSON.stringify(d)); } catch { /* private mode / quota */ }
    this.onWrite?.(d);
  };

  dispose() {
    this.flush();
    window.removeEventListener("pagehide", this.flush);
    document.removeEventListener("visibilitychange", this.flush);
  }
}
