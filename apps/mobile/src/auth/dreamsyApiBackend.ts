import * as SecureStore from 'expo-secure-store';
import { api, ApiError, request, type User } from '../api';
import type { AuthBackend, Session } from './types';

// Auth backed by services/api /v1/auth/*. The API token is kept in the keychain.
// Replace this file (not the screens) when moving to Supabase Auth.

const TOKEN_KEY = 'dreamsy.token';

type AuthResponse = { user: User; token: string };

let cachedToken: string | null = null;

async function store({ user, token }: AuthResponse): Promise<Session> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  cachedToken = token;
  return { user };
}

export const dreamsyApiBackend: AuthBackend = {
  async restore() {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (!token) return null;
    try {
      const { user } = await api.me(token);
      cachedToken = token;
      return { user };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        return null;
      }
      throw e; // network / server error: caller decides
    }
  },

  async signInWithApple({ identityToken, fullName }) {
    const body = fullName ? { identityToken, fullName } : { identityToken };
    return store(await request<AuthResponse>('/v1/auth/apple', { method: 'POST', body, auth: false }));
  },

  async signInWithSupabase(accessToken) {
    return store(
      await request<AuthResponse>('/v1/auth/supabase', { method: 'POST', body: { accessToken }, auth: false }),
    );
  },

  async startEmailSignIn(email) {
    const { expiresInSeconds } = await request<{ ok: true; expiresInSeconds: number }>('/v1/auth/email/start', {
      method: 'POST',
      body: { email },
      auth: false,
    });
    return { expiresInSeconds };
  },

  async signInWithEmailCode(email, code) {
    return store(
      await request<AuthResponse>('/v1/auth/email/verify', { method: 'POST', body: { email, code }, auth: false }),
    );
  },

  async signInAsGuest() {
    return store(await request<AuthResponse>('/v1/auth/guest', { method: 'POST', auth: false }));
  },

  async signInAsDemo(username) {
    return store(await request<AuthResponse>('/v1/auth/demo', { method: 'POST', body: { username }, auth: false }));
  },

  async signOut() {
    cachedToken = null;
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  },

  async getAccessToken() {
    return cachedToken ?? (cachedToken = await SecureStore.getItemAsync(TOKEN_KEY));
  },
};
