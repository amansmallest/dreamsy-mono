import { join, relative, resolve } from "node:path";

export const REPO = resolve(process.cwd(), "..", "..");
export const GAMES_DIR = process.env.DREAMSY_GAMES_DIR ? resolve(process.env.DREAMSY_GAMES_DIR) : join(REPO, "games", "mine");
export const DATA_DIR = join(GAMES_DIR, ".editor");
export const TOOL = join(REPO, "engine", "build", "release", "dreamsy-tool");
export const PLAYER_DIR = join(REPO, "engine", "build", "web");
export const HARNESS_DIR = join(REPO, "harness");

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isGameId = (id: string) => ID.test(id);

export function gameDir(id: string) {
  if (!isGameId(id)) throw new HttpError(404, "No such game");
  return join(GAMES_DIR, id);
}

export const dataDir = (id: string) => join(DATA_DIR, gameDir(id).slice(GAMES_DIR.length + 1));

export function inside(root: string, rel: string) {
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (!r || r.startsWith("..") || r.includes("\0")) throw new HttpError(400, "Bad path");
  return abs;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function fail(e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  return Response.json({ error: (e as Error).message ?? "Something went wrong" }, { status });
}
