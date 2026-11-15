import 'react-native-url-polyfill/auto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { SignInCancelled } from './native';

// Google sign-in through Supabase Auth (email codes go through services/api, see dreamsyApiBackend).
// OAuth runs in the system auth sheet (PKCE), then the Supabase access token is traded for a
// Dreamsy session at POST /v1/auth/supabase. The Supabase session
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
