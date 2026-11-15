/** Input state fed by the host (keyboard, touch controls, harness scripts). */
export type Button = "jump" | "action" | "action2";
export type Axis = "move_x" | "move_y" | "look_x" | "look_y";

export class InputState {
  private axes = new Map<string, number>();
  private down = new Set<string>();
  /** Edges since the last simulation tick. */
  private edges = new Set<string>();
  /** Edges visible to scripts during the current tick. */
  private tickEdges = new Set<string>();
  /** Pointer in UI reference pixels while touching, else null. */
  pointer: [number, number] | null = null;

  setAxis(name: Axis | string, v: number) {
    this.axes.set(name, Math.max(-1, Math.min(1, v)));
  }
  setButton(name: Button | string, isDown: boolean) {
    if (isDown && !this.down.has(name)) this.edges.add(name);
    if (isDown) this.down.add(name); else this.down.delete(name);
  }
  /** Convenience: press + release within one tick still registers as pressed. */
  tap(name: Button | string) {
    this.edges.add(name);
  }

  /** While true (a blocking ui.dialog is open) scripts see no input; the engine reads the raw* values. */
  blocked = false;

  /** Every input name scripts have read (so phone controls can show buttons a kit reads via config). */
  readonly read = new Set<string>();
  /** Called the first time scripts read a given name. */
  onFirstRead: ((name: string) => void) | null = null;
  /** Simulation tick counter + the tick each name was last read (phone controls hide on menus). */
  private tick = 0;
  private lastRead = new Map<string, number>();
  /** True if scripts read this input within the last `ticks` simulation ticks. */
  recentlyRead(name: string, ticks = 45): boolean {
    const t = this.lastRead.get(name);
    return t !== undefined && this.tick - t <= ticks;
  }
  private noteRead(name: string) {
    this.lastRead.set(name, this.tick);
    if (this.read.has(name)) return;
    this.read.add(name);
    this.onFirstRead?.(name);
  }

  axis(name: string): number { this.noteRead(name); return this.blocked ? 0 : this.rawAxis(name); }
  held(name: string): boolean { this.noteRead(name); return !this.blocked && this.down.has(name); }
  pressed(name: string): boolean { this.noteRead(name); return !this.blocked && this.tickEdges.has(name); }
  rawAxis(name: string): number { return this.axes.get(name) ?? 0; }
  /** Engine-side check (does not count as a script read). */
  rawHeld(name: string): boolean { return this.down.has(name); }
  rawPressed(name: string): boolean { return this.tickEdges.has(name); }

  /** Called by the simulation at the start of each tick. */
  beginTick() {
    this.tick++;
    this.tickEdges = this.edges;
    this.edges = new Set();
  }
  reset() {
    this.axes.clear(); this.down.clear(); this.edges.clear(); this.tickEdges.clear(); this.pointer = null;
  }
}
