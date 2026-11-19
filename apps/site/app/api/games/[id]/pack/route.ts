import { pack } from "@/lib/server/games";
import { fail } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const v = new URL(req.url).searchParams.get("v");
    const bytes = await pack(id, v === null ? undefined : Number(v));
    const download = new URL(req.url).searchParams.has("download");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        ...(download ? { "content-disposition": `attachment; filename="${id}${v === null ? "" : `-v${v}`}.dpk"` } : {}),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
