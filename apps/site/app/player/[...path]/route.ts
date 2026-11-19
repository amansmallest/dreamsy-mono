import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fail, HttpError, inside, PLAYER_DIR } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".dpk": "application/octet-stream",
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await params;
    const rel = path.join("/");
    if (!/^(dreamsy-player\.(html|js|wasm|data)|kits\/[a-z][a-z0-9-]*\.dpk)$/.test(rel)) throw new HttpError(404, "Not found");
    const bytes = await readFile(inside(PLAYER_DIR, rel)).catch(() => {
      throw new HttpError(503, "The web player isn't built. Run: cd engine && cmake --preset web && cmake --build --preset web --target dreamsy-player");
    });
    return new Response(new Uint8Array(bytes), { headers: { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch (e) {
    return fail(e);
  }
}
