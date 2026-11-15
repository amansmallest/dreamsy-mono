import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { jwksIdentityVerifier } from "../src/auth.js";
import type { Config } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { MemoryStorage } from "../src/storage.js";

// A stand-in Supabase project: serves /auth/v1/.well-known/jwks.json with an ES256 key, like the real
// project (asymmetric signing keys), and signs access tokens the way Supabase Auth does.
let base = "";
let server: ReturnType<typeof createServer>;
let sign: (sub: string, opts?: { aud?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
  server = createServer((req, res) => {
    if (req.url === "/auth/v1/.well-known/jwks.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  sign = (sub, opts = {}) => new SignJWT({ email: `${sub}@example.com`, role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(sub).setIssuer(opts.iss ?? `${base}/auth/v1`).setAudience(opts.aud ?? "authenticated")
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
});
afterAll(() => { server?.close(); });

async function makeApp() {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const config: Config = { jwtSecret: "x".repeat(40), workerToken: "w", dailyGenerationQuota: 5, leaseSeconds: 60, maxAttempts: 2, ssePollMs: 10, starterStars: 500, creatorShare: 0.5, playPrice: 10000, playPassMinutes: 30, createPrice: 0, remixPrice: 0 };
  return createApp({ db: d as unknown as DB, storage: new MemoryStorage(), config, identity: jwksIdentityVerifier({ apple: [], google: [] }, { url: base }) });
}

const post = (app: Awaited<ReturnType<typeof makeApp>>, accessToken: string) =>
  app.request("/v1/auth/supabase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });

describe("Supabase sign-in exchange (web dashboard + app)", () => {
  it("exchanges a Supabase ES256 access token for a Dreamsy token; same Supabase user → same Dreamsy user", async () => {
    const app = await makeApp();
    const r1 = await post(app, await sign("supa-user-1"));
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { user: { id: string }; token: string };
    const r2 = await post(app, await sign("supa-user-1"));
    const b2 = await r2.json() as { user: { id: string } };
    expect(b2.user.id).toBe(b1.user.id);
    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${b1.token}` } });
    expect(me.status).toBe(200);
  });

  it("rejects tokens with the wrong audience, issuer or signature", async () => {
    const app = await makeApp();
    expect((await post(app, await sign("u", { aud: "anon" }))).status).toBe(401);
    expect((await post(app, await sign("u", { iss: "https://evil.example/auth/v1" }))).status).toBe(401);
    const forged = (await sign("u")).replace(/\.[^.]+$/, ".AAAA");
    expect((await post(app, forged)).status).toBe(401);
  });
});
