import { library } from "@/lib/server/cloud";
import { fail } from "@/lib/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    return Response.json(await library((u.searchParams.get("q") ?? "").trim().slice(0, 80), Number(u.searchParams.get("before")) || undefined));
  } catch (e) {
    return fail(e);
  }
}
