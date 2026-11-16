// Room-code entry without the system keyboard (phones: the keyboard covered the lobby and codes never went in).
// DOM-free state; net/lobby.ts draws it as an on-screen keypad. Only the code alphabet, 6 slots, auto-submit when full.
import { CODE_ALPHABET } from "./protocol.js";

export const CODE_LENGTH = 6;

/** Keypad layout: 6 columns (fits a 320 px panel with ≥ 48 px keys). "⌫" = backspace. */
export const KEYPAD_ROWS: readonly (readonly string[])[] = (() => {
  const keys = [...CODE_ALPHABET.split("").sort((a, b) => {
    const da = /\d/.test(a), db = /\d/.test(b);
    return da === db ? a.localeCompare(b) : da ? 1 : -1;
  }), "⌫"];
  const rows: string[][] = [];
  for (let i = 0; i < keys.length; i += 6) rows.push(keys.slice(i, i + 6));
  return rows;
})();

export class CodeEntry {
  private chars: string[] = [];

  /** `onComplete` runs when the 6th character goes in (typed or pasted). */
  constructor(private onComplete: (code: string) => void, private onChange: () => void = () => {}) {}

  get value(): string { return this.chars.join(""); }
  get length(): number { return this.chars.length; }
  get full(): boolean { return this.chars.length === CODE_LENGTH; }
  /** Slot contents for drawing ("" = empty). */
  slots(): string[] { return Array.from({ length: CODE_LENGTH }, (_, i) => this.chars[i] ?? ""); }

  /** One key: a code character (any case) or "⌫" / "Backspace". Returns whether it was accepted. */
  press(key: string): boolean {
    if (key === "⌫" || key === "Backspace") { this.backspace(); return true; }
    const ch = key.toUpperCase();
    if (ch.length !== 1 || !CODE_ALPHABET.includes(ch) || this.full) return false;
    this.chars.push(ch);
    this.onChange();
    if (this.full) this.onComplete(this.value);
    return true;
  }

  backspace() {
    if (!this.chars.length) return;
    this.chars.pop();
    this.onChange();
  }

  clear() {
    this.chars = [];
    this.onChange();
  }

  /**
   * Paste: a bare code, a sentence containing one, or a share link (…&room=ABC234). Replaces what was typed.
   * Characters outside the code alphabet (0 O 1 I L, punctuation) are dropped. Returns the accepted code.
   */
  paste(text: string): string {
    const fromUrl = /[?&#]room=([A-Za-z0-9]+)/.exec(text)?.[1];
    const src = (fromUrl ?? (/\b([A-Za-z0-9]{6})\b/.exec(text.trim())?.[1] ?? text)).toUpperCase();
    const chars = [...src].filter((c) => CODE_ALPHABET.includes(c)).slice(0, CODE_LENGTH);
    this.chars = chars;
    this.onChange();
    if (this.full) this.onComplete(this.value);
    return this.value;
  }
}
