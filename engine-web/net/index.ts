// Multiplayer client side (DREAMSY.MD §4.5). DOM-free; the lobby UI lives in ./lobby.ts (browser only).
export * from "./protocol.js";
export { ClockSync, SnapshotBuffer, lerpAngle, type Sample, type Interpolated } from "./interp.js";
export { LoopbackRoom, matchResult } from "./loopback.js";
export { RoomClient, RoomError } from "./client.js";
