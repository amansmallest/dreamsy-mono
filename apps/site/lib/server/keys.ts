import { cookies } from "next/headers";
import type { KeyStatus, Provider } from "../editor-types";

export const PROVIDERS: Provider[] = ["anthropic", "openai", "gemini"];
const cookieName = (p: Provider) => `dreamsy_key_${p}`;

export async function readKeys(): Promise<Partial<Record<Provider, string>>> {
  const jar = await cookies();
  return Object.fromEntries(PROVIDERS.map((p) => [p, jar.get(cookieName(p))?.value]).filter(([, v]) => v)) as Partial<Record<Provider, string>>;
}

export async function keyStatus(): Promise<KeyStatus> {
  const keys = await readKeys();
  const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : null);
  return { anthropic: mask(keys.anthropic), openai: mask(keys.openai), gemini: mask(keys.gemini) };
}

export async function saveKey(provider: Provider, key: string) {
  (await cookies()).set(cookieName(provider), key, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function removeKey(provider: Provider) {
  (await cookies()).delete(cookieName(provider));
}

