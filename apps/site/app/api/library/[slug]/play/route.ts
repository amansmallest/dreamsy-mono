import { countPlay } from "@/lib/server/cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (/^[a-z0-9]{4,32}$/.test(slug)) await countPlay(slug);
  return Response.json({ ok: true });
}
