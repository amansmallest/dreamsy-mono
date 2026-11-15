import type { User } from '../api';

export type { User };

/** Credential from the native Apple sheet. */
export type AppleCredential = {
  identityToken: string;
  fullName?: string;
};

export type Session = { user: User };

/**
 * The swappable part of auth: turns credentials into a session and owns token storage.
 * Today: services/api `/v1/auth/*` (dreamsyApiBackend); email codes come from services/api itself, Google
 * arrives as a Supabase access token.
 * Screens never see this; they use useAuth().
 */
export interface AuthBackend {
  /** Restore a stored session. Resolve null if there is none or it was rejected (401). */
  restore(): Promise<Session | null>;
  signInWithApple(credential: AppleCredential): Promise<Session>;
  /** Trade a Supabase Auth access token (Google OAuth) for a session. */
  signInWithSupabase(accessToken: string): Promise<Session>;
  /** Email sign-in step 1: services/api emails a 6-digit code. Resolves the code's lifetime in seconds. */
  startEmailSignIn(email: string): Promise<{ expiresInSeconds: number }>;
  /** Email sign-in step 2: the code -> session. 400 "wrong code" / "code expired; ask for a new one". */
  signInWithEmailCode(email: string, code: string): Promise<Session>;
  signInAsGuest(): Promise<Session>;
  /** Demo account by username (no email step); the API allows usernames ending in _demo. */
  signInAsDemo(username: string): Promise<Session>;
  signOut(): Promise<void>;
  /** Current bearer token for services/api, or null if signed out. May refresh. */
  getAccessToken(): Promise<string | null>;
}
