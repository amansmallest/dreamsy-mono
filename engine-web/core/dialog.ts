// ui.dialog / ui.choice state machine (core, deterministic). The renderer draws `current`;
// taps arrive via Game.dialogTap(), buttons via the input state (jump / action advance).

export interface DialogLine { text: string; speaker?: string; portrait?: string }

export interface DialogState {
  id: number;
  kind: "dialog" | "choice";
  lines: DialogLine[];
  index: number;
  /** Characters revealed in the current line (typewriter). */
  shown: number;
  /** Characters per second; 0 = instant. */
  speed: number;
  /** choice only: option labels and the highlighted option (0-based). */
  options: string[];
  selected: number;
  position: "bottom" | "top";
  /** Hide game input from scripts while open (default true). */
  blocking: boolean;
}

export interface DialogInput {
  /** jump/action pressed this tick. */
  confirm: boolean;
  /** move_y / up-down edge this tick: -1 up, +1 down, 0 none. */
  nav: number;
  /** Tap on the dialog (option index for a choice option, -1 = the box). */
  tap: number | null;
}

/** Result of a step: a dialog finished (choice = 0-based option, -1 for plain dialogs). */
export interface DialogDone { id: number; choice: number }

export class Dialogs {
  current: DialogState | null = null;
  queue: DialogState[] = [];
  /** Bumped on every visible change (renderer diff). */
  rev = 0;

  open(d: DialogState) {
    if (this.current) this.queue.push(d);
    else { this.current = d; this.rev++; }
  }

  get lineDone(): boolean {
    const c = this.current;
    return !c || c.shown >= (c.lines[c.index]?.text.length ?? 0);
  }

  /** Close a dialog by id without firing (dlg:close()) — returns true when it was open/queued. */
  close(id: number): boolean {
    if (this.current?.id === id) { this.current = this.queue.shift() ?? null; this.rev++; return true; }
    const n = this.queue.length;
    this.queue = this.queue.filter((d) => d.id !== id);
    return this.queue.length !== n;
  }

  clear() { this.current = null; this.queue = []; this.rev++; }

  step(dt: number, inp: DialogInput): DialogDone | null {
    const c = this.current;
    if (!c) return null;
    const line = c.lines[c.index]!;
    const len = line.text.length;
    if (c.shown < len) {
      const before = Math.floor(c.shown);
      c.shown = c.speed <= 0 ? len : Math.min(len, c.shown + c.speed * dt);
      if (Math.floor(c.shown) !== before) this.rev++;
    }
    const typing = c.shown < len;
    const isLast = c.index >= c.lines.length - 1;
    // choice: options are live once the prompt is fully shown
    if (c.kind === "choice" && isLast && !typing) {
      if (inp.nav) { c.selected = (c.selected + inp.nav + c.options.length) % c.options.length; this.rev++; }
      if (inp.tap !== null && inp.tap >= 0 && inp.tap < c.options.length) return this.finish(inp.tap);
      if (inp.confirm) return this.finish(c.selected);
      return null;
    }
    if (inp.tap !== null && c.kind === "choice" && inp.tap >= 0 && isLast) {
      // tapped an option while the prompt was still typing: accept it
      return this.finish(Math.min(inp.tap, c.options.length - 1));
    }
    if (!inp.confirm && inp.tap === null) return null;
    if (typing) { c.shown = len; this.rev++; return null; }
    if (!isLast) { c.index++; c.shown = 0; this.rev++; return null; }
    return this.finish(-1);
  }

  private finish(choice: number): DialogDone {
    const id = this.current!.id;
    this.current = this.queue.shift() ?? null;
    this.rev++;
    return { id, choice };
  }
}
