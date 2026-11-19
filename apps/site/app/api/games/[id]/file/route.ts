import { extname } from "node:path";
import { readGameFile } from "@/lib/server/games";
import { fail, HttpError } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const path = new URL(req.url).searchParams.get("path");
    if (!path) throw new HttpError(400, "Missing path");
    const bytes = await readGameFile(id, path);
    const type = TYPES[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8";
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": type, "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" },
    });
  } catch (e) {
    return fail(e);
  }
}
