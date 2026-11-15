import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { fail, type Config, type Env, type IdentityProvider, type IdentityVerifier } from "./context.js";

const PROVIDERS = {
  apple: {
    jwks: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
  },
  google: {
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
} as const;

export type SupabaseAuthConfig = {
  /** Project URL, e.g. https://abcd.supabase.co */
  url: string;
  /** Legacy HS256 JWT secret. Unset = verify against the project's JWKS (asymmetric signing keys). */
  jwtSecret?: string;
};

/**
 * Verifies Apple / Google ID tokens against their public JWKS, and Supabase access tokens against
 * the project's JWKS (or its legacy HS256 secret).
 * `audiences.apple` = iOS bundle id(s) (+ Services ID for web later).
 * `audiences.google` = OAuth client id(s) the app requests tokens for (the web client id).
 */
export function jwksIdentityVerifier(
  audiences: Record<"apple" | "google", string[]>,
  supabase?: SupabaseAuthConfig,
): IdentityVerifier {
  const sets = {
    apple: createRemoteJWKSet(new URL(PROVIDERS.apple.jwks)),
    google: createRemoteJWKSet(new URL(PROVIDERS.google.jwks)),
  };
  const supabaseUrl = supabase?.url.replace(/\/+$/, "");
  const supabaseKey = supabaseUrl
    ? supabase!.jwtSecret
      ? key(supabase!.jwtSecret)
      : createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    : null;

  const verifyWith = (provider: IdentityProvider, token: string) => {
    if (provider === "supabase") {
      if (!supabaseKey) fail(400, "supabase sign-in is not configured");
      return jwtVerify(token, supabaseKey as Parameters<typeof jwtVerify>[1], {
        issuer: `${supabaseUrl}/auth/v1`,
        audience: "authenticated",
      });
    }
    if (audiences[provider].length === 0) fail(400, `${provider} sign-in is not configured`);
    return jwtVerify(token, sets[provider], {
      issuer: [...PROVIDERS[provider].issuers],
      audience: audiences[provider],
    });
  };

  return {
    async verify(provider, token) {
      const pending = verifyWith(provider, token);
      try {
        const { payload } = await pending;
        if (!payload.sub) throw new Error("no sub");
        const email = typeof payload.email === "string" ? payload.email : null;
        return { subject: payload.sub, email };
      } catch {
        fail(401, `invalid ${provider} token`);
      }
    },
  };
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signUserToken(config: Config, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key(config.jwtSecret));
}

function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer (.+)$/);
  return m?.[1] ?? null;
}

/** Player/creator auth. v0 = guest accounts; Sign in with Apple later. */
export function requireUser(config: Config): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) fail(401, "missing bearer token");
    try {
      const { payload } = await jwtVerify(token, key(config.jwtSecret), { algorithms: ["HS256"] });
      if (!payload.sub) fail(401, "invalid token");
      c.set("userId", payload.sub);
    } catch {
      fail(401, "invalid token");
    }
    await next();
  };
}


/** Harness workers share one secret token (v0). */
export function requireWorker(config: Config): MiddlewareHandler<Env> {
  const expected = Buffer.from(config.workerToken);
  return async (c, next) => {
    const got = Buffer.from(bearer(c.req.header("authorization")) ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) fail(401, "invalid worker token");
    await next();
  };
}

/** For **public** routes: sets `userId` when a valid bearer token is sent, otherwise stays anonymous. */
export function optionalUser(config: Config): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    if (token) {
      try {
        const { payload } = await jwtVerify(token, key(config.jwtSecret), { algorithms: ["HS256"] });
        if (payload.sub) c.set("userId", payload.sub);
      } catch {
        // public route: a stale token just means anonymous
      }
    }
    await next();
  };
}
