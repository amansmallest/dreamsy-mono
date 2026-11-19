import { importMine } from "@/lib/server/cloud";
import { fail, HttpError } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ cloudId: string }> }) {
  try {
    const { cloudId } = await params;
    if (!/^[a-z0-9]{8,32}$/.test(cloudId)) throw new HttpError(404, "No such game");
    return Response.json({ id: await importMine(cloudId) });
  } catch (e) {
    return fail(e);
  }
}
