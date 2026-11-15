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
 * Today: services/api `/v1/auth/*` (dreamsyApiBackend); Google arrives as a Supabase access token.
 * Screens never see this; they use useAuth().
 */
export interface AuthBackend {
  /** Restore a stored session. Resolve null if there is none or it was rejected (401). */
  restore(): Promise<Session | null>;
  signInWithApple(credential: AppleCredential): Promise<Session>;
  /** Trade a Supabase Auth access token (Google OAuth) for a session. */
  signInWithSupabase(accessToken: string): Promise<Session>;
  signInAsGuest(): Promise<Session>;
  signOut(): Promise<void>;
  /** Current bearer token for services/api, or null if signed out. May refresh. */
  getAccessToken(): Promise<string | null>;
}
