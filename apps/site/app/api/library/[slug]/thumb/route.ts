import { libraryThumb } from "@/lib/server/cloud";
import { fail, HttpError } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    if (!/^[a-z0-9]{4,32}$/.test(slug)) throw new HttpError(404, "No such game");
    return new Response(new Uint8Array(await libraryThumb(slug)), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=300" } });
  } catch (e) {
    return fail(e);
  }
}
