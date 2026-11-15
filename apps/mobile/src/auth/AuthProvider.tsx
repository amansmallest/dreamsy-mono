import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { configureApi } from '../api';
import { dreamsyApiBackend } from './dreamsyApiBackend';
import { getAppleCredential } from './native';
import { googleAccessToken } from './supabase';
import type { AuthBackend, Session, User } from './types';

// The one backend in use.
const backend: AuthBackend = dreamsyApiBackend;

type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'signedOut'; user: null }
  | { status: 'signedIn'; user: User };

export type AuthContextValue = AuthState & {
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Step 1 of email sign-in (services/api): email a 6-digit code. Resolves its lifetime in seconds. */
  sendEmailCode: (email: string) => Promise<number>;
  /** Step 2: verify the code and sign in. */
  signInWithEmailCode: (email: string, code: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  /** Demo account by username, no code step. */
  signInAsDemo: (username: string) => Promise<void>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  /** Replace the signed-in user after a profile edit (PATCH /v1/me). */
  updateUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const signedOut: AuthState = { status: 'signedOut', user: null };
const toState = (s: Session | null): AuthState =>
  s ? { status: 'signedIn', user: s.user } : signedOut;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

  const signOut = useCallback(async () => {
    await backend.signOut();
    setState(signedOut);
  }, []);

  // API client gets its bearer token from the backend; any 401 on an authed call signs out.
  useEffect(() => {
    configureApi({
      getAccessToken: () => backend.getAccessToken(),
      onUnauthorized: () => void signOut(),
    });
  }, [signOut]);

  // Restore the session on launch.
  useEffect(() => {
    let cancelled = false;
    backend
      .restore()
      // Network/server error: show sign-in for now. TODO: offline mode with a cached user.
      .catch(() => null)
      .then((s) => !cancelled && setState(toState(s)));
    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithApple = useCallback(async () => {
    setState(toState(await backend.signInWithApple(await getAppleCredential())));
  }, []);
  const signInWithGoogle = useCallback(async () => {
    setState(toState(await backend.signInWithSupabase(await googleAccessToken())));
  }, []);
  const sendEmailCode = useCallback(async (email: string) => (await backend.startEmailSignIn(email)).expiresInSeconds, []);
  const signInWithEmailCode = useCallback(async (email: string, code: string) => {
    setState(toState(await backend.signInWithEmailCode(email, code)));
  }, []);
  const continueAsGuest = useCallback(async () => {
    setState(toState(await backend.signInAsGuest()));
  }, []);

  const signInAsDemo = useCallback(async (username: string) => {
    setState(toState(await backend.signInAsDemo(username)));
  }, []);

  const updateUser = useCallback((user: User) => {
    setState((s) => (s.status === 'signedIn' ? { status: 'signedIn', user } : s));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signInWithApple,
      signInWithGoogle,
      sendEmailCode,
      signInWithEmailCode,
      continueAsGuest,
      signInAsDemo,
      signOut,
      getAccessToken: () => backend.getAccessToken(),
      updateUser,
    }),
    [state, signInWithApple, signInWithGoogle, sendEmailCode, signInWithEmailCode, continueAsGuest, signInAsDemo, signOut, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
