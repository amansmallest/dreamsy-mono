// Auth: Supabase (email OTP + OAuth) exchanged for a Dreamsy API token via POST /v1/auth/supabase,
// or — only when VITE_SUPABASE_URL is unset — a dev guest account (POST /v1/auth/guest).
// Email code: our API (Resend), stored like a guest token.
// Demo bypass: a username ending in _demo (or a special name) signs in with no code (POST /v1/auth/demo).
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setApiHooks, type User } from './api';
import { env, supabaseEnabled } from './env';
import { clearBlobCache } from './blobs';
import { clearCache } from './store';

const GUEST_KEY = 'dreamsy.web.guestToken';

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(env.supabaseUrl, env.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null;

export type Providers = { google: boolean; apple: boolean; email: boolean };

type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'signedOut'; user: null; error?: string }
  | { status: 'signedIn'; user: User };

type AuthApi = {
  state: AuthState;
  mode: 'supabase' | 'guest';
  providers: Providers;
  sendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  signInWithOAuth: (provider: 'google' | 'apple') => Promise<void>;
  continueAsGuest: () => Promise<void>;
  demoSignIn: (username: string) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: User) => void;
};

const Ctx = createContext<AuthApi | null>(null);

const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  const [providers, setProviders] = useState<Providers>({ google: true, apple: false, email: true });
  const token = useRef<string | null>(storage.get(GUEST_KEY)); // guest or demo token
  const exchanging = useRef<Promise<string | null> | null>(null);

  const signedOut = useCallback((error?: string) => {
    token.current = null;
    storage.set(GUEST_KEY, null);
    clearCache();
    clearBlobCache();
    setState({ status: 'signedOut', user: null, error });
  }, []);

  /** Supabase session → Dreamsy token (deduped). */
  const exchange = useCallback(async (session: Session | null): Promise<string | null> => {
    if (!session) return null;
    exchanging.current ??= api.exchangeSupabase(session.access_token)
      .then(({ user, token: t }) => {
        token.current = t;
        setState({ status: 'signedIn', user });
        return t;
      })
      .finally(() => { exchanging.current = null; });
    return exchanging.current;
  }, []);

  useEffect(() => {
    setApiHooks({
      getToken: () => token.current,
      onUnauthorized: async () => {
        if (supabase && !storage.get(GUEST_KEY)) {
          try {
            const { data } = await supabase.auth.refreshSession();
            const t = await exchange(data.session);
            if (t) return t;
          } catch { /* fall through */ }
          await supabase.auth.signOut().catch(() => {});
        }
        signedOut('Your session expired. Sign in again.');
        return null;
      },
    });
  }, [exchange, signedOut]);

  useEffect(() => {
    if (!supabase) {
      if (!token.current) return setState({ status: 'signedOut', user: null });
      api.me().then(({ user }) => setState({ status: 'signedIn', user }), (e) => signedOut(e.status === 401 ? undefined : String(e.message)));
      return;
    }
    fetch(`${env.supabaseUrl}/auth/v1/settings`, { headers: { apikey: env.supabaseKey } })
      .then((r) => r.json())
      .then((s: { external?: Record<string, boolean> }) =>
        setProviders({ google: !!s.external?.google, apple: !!s.external?.apple, email: s.external?.email !== false }))
      .catch(() => {});

    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      if (!data.session) {
        if (!token.current) return setState({ status: 'signedOut', user: null });
        // Demo account (no Supabase session): resume with the stored API token.
        return api.me().then(({ user }) => alive && setState({ status: 'signedIn', user }), () => alive && signedOut());
      }
      try { await exchange(data.session); } catch (e) { signedOut(String((e as Error).message)); }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Defer: supabase-js warns against awaiting inside the callback.
        setTimeout(() => exchange(session).catch((e) => signedOut(String(e.message))), 0);
      } else if (event === 'SIGNED_OUT') signedOut();
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [exchange, signedOut]);

  const value = useMemo<AuthApi>(() => ({
    state,
    mode: supabase ? 'supabase' : 'guest',
    providers,
    // Email codes are ours (POST /v1/auth/email/*, sent via Resend), not Supabase's.
    async sendEmailCode(email) {
      await api.emailStart(email);
    },
    async verifyEmailCode(email, code) {
      const { user, token: t } = await api.emailVerify(email, code);
      token.current = t;
      storage.set(GUEST_KEY, t);
      setState({ status: 'signedIn', user });
    },
    async signInWithOAuth(provider) {
      if (!supabase) throw new Error('Supabase is not configured');
      const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin + window.location.pathname } });
      if (error) throw error;
    },
    async continueAsGuest() {
      const { user, token: t } = await api.guest();
      token.current = t;
      storage.set(GUEST_KEY, t);
      setState({ status: 'signedIn', user });
    },
    async demoSignIn(username) {
      const { user, token: t } = await api.demo(username);
      token.current = t;
      storage.set(GUEST_KEY, t);
      setState({ status: 'signedIn', user });
    },
    async signOut() {
      if (supabase) await supabase.auth.signOut().catch(() => {});
      signedOut();
    },
    setUser: (user) => setState({ status: 'signedIn', user }),
  }), [state, providers, exchange, signedOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('not signed in');
  return state.user;
}
