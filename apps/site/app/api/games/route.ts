import { createGame, listGames } from "@/lib/server/games";
import { fail } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ games: await listGames() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { name } = (await req.json()) as { name?: string };
    return Response.json({ id: await createGame(name ?? "") });
  } catch (e) {
    return fail(e);
  }
}
