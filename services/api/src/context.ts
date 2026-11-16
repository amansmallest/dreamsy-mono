import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { DB } from "./db/client.js";
import type { LiveFetcher, PresenceFetcher } from "./presence.js";
import type { Storage } from "./storage.js";

export interface Config {
  jwtSecret: string;
  workerToken: string;
  dailyGenerationQuota: number;
  /** How long a worker owns a claimed job without sending events. */
  leaseSeconds: number;
  maxAttempts: number;
  ssePollMs: number;
  /** Free coins every new wallet starts with (STARTER_STARS; the ledger is still "Stars" internally). */
  starterStars: number;
  /** Share of each play / store sale credited to the game's creator (0..1); the rest goes to the platform. */
  creatorShare: number;
  /** Coins to start someone else's game (PLAY_PRICE, §11.6). */
  playPrice: number;
  /** How long a paid start keeps replays free (PLAY_PASS_MINUTES). */
  playPassMinutes: number;
  /** Coins for a game's first build (CREATE_PRICE, §11.6) → platform; refunded if it yields no version. Edits are free. */
  createPrice: number;
  /** Coins to remix someone else's game (REMIX_PRICE) → 100% to the original owner. */
  remixPrice: number;
  /** Coins from each paid play of a spin-off that go to the parent game's owner (taken from the spin-off creator's share). Default 1000. */
  spinoffRoyalty?: number;
  /** The guided first experience's game (ONBOARDING_GAME_ID); default DEFAULT_ONBOARDING_GAME_ID. First play free until onboarded. */
  onboardingGameId?: string;
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
  /** Sends Expo push messages; defaults to the Expo push API. Swappable so tests capture pushes. */
  pusher?: Pusher;
  /** Friend presence from the room server; defaults to HTTP GET $GAMESERVER_INTERNAL_URL/internal/presence. Swappable in tests. */
  presence?: PresenceFetcher;
  /** Live rooms from the room server; defaults to HTTP GET $GAMESERVER_INTERNAL_URL/internal/live. Swappable in tests. */
  live?: LiveFetcher;
}

/** One Expo push message (https://docs.expo.dev/push-notifications/sending-notifications/). */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: "default";
  badge: number;
}
/** Expo push ticket, one per message, same order. */
export type PushTicket = { status: "ok"; id?: string } | { status: "error"; message?: string; details?: { error?: string } };
export type Pusher = (messages: PushMessage[]) => Promise<PushTicket[]>;

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
