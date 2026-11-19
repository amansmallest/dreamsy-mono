import { activeRun } from "@/lib/server/builds";
import { syncGame } from "@/lib/server/cloud";
import { fail, gameDir, HttpError } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    gameDir(id);
    if (activeRun(id)) throw new HttpError(409, "Wait for the current build to finish");
    return Response.json({ cloud: await syncGame(id, "Saved from the editor") });
  } catch (e) {
    return fail(e);
  }
}
