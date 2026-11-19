import { fail, HttpError } from "@/lib/server/paths";
import { keyStatus, PROVIDERS, removeKey, saveKey } from "@/lib/server/keys";
import type { Provider } from "@/lib/editor-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const provider = (v: unknown): Provider => {
  if (!PROVIDERS.includes(v as Provider)) throw new HttpError(400, "Unknown provider");
  return v as Provider;
};

export async function GET() {
  return Response.json(await keyStatus());
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: string; key?: string };
    const key = body.key?.trim() ?? "";
    if (key.length < 16 || key.length > 400 || /\s/.test(key)) throw new HttpError(400, "That doesn't look like an API key");
    await saveKey(provider(body.provider), key);
    return Response.json(await keyStatus());
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  try {
    await removeKey(provider(new URL(req.url).searchParams.get("provider")));
    return Response.json(await keyStatus());
  } catch (e) {
    return fail(e);
  }
}
