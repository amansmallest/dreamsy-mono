// Engine → host bridge (no DOM types: unit-tested in Node). Every message goes to the React Native WebView
// (JSON string) and, when the engine runs inside an iframe (web studio), to window.parent (the object, origin "*").
import type { RunEnd } from "../core/game.js";

export type BridgeMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "quit" }
  | { type: "purchase"; itemId: string; balance: number | null }
  | { type: "save"; key: string; data: unknown }
  | ({ type: "runEnd" } & RunEnd);

export interface BridgeWindow {
  ReactNativeWebView?: { postMessage(data: string): void };
  parent?: { postMessage(msg: unknown, targetOrigin: string): void } | null;
}

export function postToHost(win: BridgeWindow, msg: BridgeMessage) {
  try { win.ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch { /* host gone */ }
  // top-level pages have parent === window: nothing to tell
  if (win.parent && (win.parent as unknown) !== win) {
    try { win.parent.postMessage(msg, "*"); } catch { /* cross-origin parent gone */ }
  }
}

/** {type:"runEnd"} payload: only the fields that are set. */
export function runEndMessage(ev: RunEnd): BridgeMessage {
  const m: { type: "runEnd" } & RunEnd = { type: "runEnd", reason: ev.reason };
  if (ev.board !== undefined) m.board = ev.board;
  if (ev.value !== undefined) m.value = ev.value;
  if (ev.rank !== undefined) m.rank = ev.rank;
  return m;
}
