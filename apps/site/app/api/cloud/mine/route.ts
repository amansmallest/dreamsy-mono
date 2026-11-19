import { links, mine } from "@/lib/server/cloud";
import { fail, GAMES_DIR } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [games, linked] = await Promise.all([mine(), links()]);
    const local = new Map(Object.entries(linked).filter(([dir]) => dir.startsWith(`${GAMES_DIR}/`)).map(([dir, cid]) => [cid, dir.slice(GAMES_DIR.length + 1)]));
    return Response.json({ games: games.map((g) => ({ ...g, localId: local.get(g.id) ?? null })) });
  } catch (e) {
    return fail(e);
  }
}
