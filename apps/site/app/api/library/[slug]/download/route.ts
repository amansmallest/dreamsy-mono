import { libraryPackage } from "@/lib/server/cloud";
import { fail, HttpError } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    if (!/^[a-z0-9]{4,32}$/.test(slug)) throw new HttpError(404, "No such game");
    const { game, bytes } = await libraryPackage(slug);
    const file = `${game.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || slug}.dpk`;
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${file}"` } });
  } catch (e) {
    return fail(e);
  }
}
