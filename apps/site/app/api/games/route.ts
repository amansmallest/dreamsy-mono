import { bannersPending } from "@/lib/server/banners";
import { createGame, listGames } from "@/lib/server/games";
import { fail } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const games = await listGames();
    return Response.json({ games, bannersPending: bannersPending() });
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
