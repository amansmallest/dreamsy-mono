import { and, eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { requireUser } from "../auth.js";
import { fail, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic"]);

/** Reference images attached to prompts. */
export function uploadRoutes({ db, storage, config }: Deps) {
  const r = router();
  r.use("/v1/uploads/*", requireUser(config));
  r.use("/v1/uploads", requireUser(config));

  r.post(
    "/v1/uploads",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: () => fail(413, "upload too large") }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form["file"];
      if (!(file instanceof File)) fail(400, "multipart field 'file' is required");
      if (!IMAGE_TYPES.has(file.type)) fail(415, "file must be png, jpeg, webp or heic");
      if (file.size > MAX_UPLOAD_BYTES) fail(413, "upload too large");

      const id = newId("up");
      const key = `uploads/${id}`;
      await storage.put(key, new Uint8Array(await file.arrayBuffer()), file.type);
      const [row] = await db.insert(schema.uploads).values({
        id,
        ownerId: c.get("userId"),
        key,
        contentType: file.type,
        sizeBytes: file.size,
      }).returning();
      return c.json({ upload: uploadView(row!) }, 201);
    },
  );

  r.get("/v1/uploads/:id", async (c) => {
    const [row] = await db.select().from(schema.uploads)
      .where(and(eq(schema.uploads.id, c.req.param("id")), eq(schema.uploads.ownerId, c.get("userId"))));
    if (!row) fail(404, "upload not found");
    return blobResponse(storage, row.key, row.contentType);
  });

  return r;
}

export const uploadView = (u: typeof schema.uploads.$inferSelect) => ({
  id: u.id,
  contentType: u.contentType,
  sizeBytes: u.sizeBytes,
  createdAt: u.createdAt,
});

export async function blobResponse(storage: Deps["storage"], key: string, contentType: string) {
  const body = await storage.get(key);
  if (!body) fail(404, "blob not found");
  return new Response(body, { headers: { "content-type": contentType, "content-length": String(body.byteLength) } });
}
