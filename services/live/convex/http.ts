import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : null);

/** POST /ingest — called by the Dreamsy API (Bearer INGEST_SECRET) for each mirrored build step. */
http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
    let body: unknown;
    try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    if (typeof body !== "object" || body === null) return new Response("bad body", { status: 400 });
    const b = body as Record<string, unknown>;
    const genId = str(b.genId, 64), gameId = str(b.gameId, 64), type = str(b.type, 40);
    const status = b.status === "succeeded" || b.status === "failed" ? b.status : "running";
    if (!genId || !gameId || !type) return new Response("genId, gameId, type required", { status: 400 });
    await ctx.runMutation(internal.live.ingest, {
      genId, gameId, type, status,
      gameName: str(b.gameName, 80) ?? "",
      creator: str(b.creator, 40) ?? "",
      kind: str(b.kind, 20) ?? "unknown",
      text: str(b.text, 200) ?? type,
      version: typeof b.version === "number" ? b.version : null,
    });
    return new Response(null, { status: 204 });
  }),
});

export default http;
