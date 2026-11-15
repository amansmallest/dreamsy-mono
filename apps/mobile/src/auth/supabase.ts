import 'react-native-url-polyfill/auto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { SignInCancelled } from './native';

// Email code (default) and Google sign-in through Supabase Auth. Email: signInWithOtp sends a
// one-time code, verifyOtp turns it into a session. Google: OAuth in the system auth sheet (PKCE), then the Supabase
// access token is traded for a Dreamsy session at POST /v1/auth/supabase. The Supabase session
// itself is not kept; services/api issues the token the app uses.
//
// Works in Expo Go (redirect exp://…/--/auth-callback) and in builds (dreamsy://auth-callback).
// Both must be allowed in Supabase → Authentication → URL Configuration → Redirect URLs.

const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

export const isSupabaseConfigured = !!url && !!anonKey;

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!isSupabaseConfigured) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  return (client ??= createClient(url!, anonKey!, {
    auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }));
}

/** Runs the Google OAuth sheet and returns a Supabase access token. */
export async function googleAccessToken(): Promise<string> {
  const sb = supabase();
  const redirectTo = Linking.createURL('auth-callback');
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') throw new SignInCancelled();

  const { queryParams } = Linking.parse(result.url);
  const failure = queryParams?.error_description ?? queryParams?.error;
  if (failure) throw new Error(String(failure));
  const code = queryParams?.code;
  if (typeof code !== 'string') throw new Error('Google sign-in did not return a code');

  const exchanged = await sb.auth.exchangeCodeForSession(code);
  if (exchanged.error) throw exchanged.error;
  return exchanged.data.session.access_token;
}

/** Email a one-time sign-in code (creates the Supabase user on first use). */
export async function sendEmailCode(email: string): Promise<void> {
  const { error } = await supabase().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}

/** Check the emailed code and return a Supabase access token. */
export async function verifyEmailCode(email: string, code: string): Promise<string> {
  const { data, error } = await supabase().auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) throw error;
  if (!data.session) throw new Error('That code did not sign you in. Ask for a new one.');
  return data.session.access_token;
}
