import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { DB } from "./db/client.js";
import type { Storage } from "./storage.js";

export interface Config {
  jwtSecret: string;
  workerToken: string;
  dailyGenerationQuota: number;
  /** How long a worker owns a claimed job without sending events. */
  leaseSeconds: number;
  maxAttempts: number;
  ssePollMs: number;
  /** Free Stars every new wallet starts with. */
  starterStars: number;
  /** Share of each sale credited to the game's creator (0..1). */
  creatorShare: number;
}

export type IdentityProvider = "apple" | "google" | "supabase";

/** Verifies a provider-issued ID token (or a Supabase access token). Swappable so tests don't hit the providers. */
export interface IdentityVerifier {
  verify(provider: IdentityProvider, token: string): Promise<{ subject: string; email: string | null }>;
}

/** Sends transactional email (sign-in codes). Resend in production; swappable in tests. */
export interface Mailer {
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<void>;
}

export interface Deps {
  db: DB;
  storage: Storage;
  config: Config;
  identity: IdentityVerifier;
  /** Email-code sign-in is disabled (503) without one. */
  mailer?: Mailer;
}

export type Env = { Variables: { userId: string } };

export const router = () => new Hono<Env>();

/** Throw an HTTP error. `extra` fields are merged into the JSON body next to `error`. */
export function fail(status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 429, message: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, { message, cause: extra });
}

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    fail(400, "body must be JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    fail(400, result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}
