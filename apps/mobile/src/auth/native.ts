import * as AppleAuthentication from 'expo-apple-authentication';
import { isExpoGo } from '../runtime';
import type { AppleCredential } from './types';

// Native credential acquisition (Apple). Google goes through Supabase OAuth (./supabase.ts).
// Apple sign-in exists in Expo Go, but its identity token is issued for Expo Go's bundle id
// (wrong audience for our API), so it is reported unavailable there.

/** User dismissed the sign-in sheet. Callers should ignore it silently. */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

export const isAppleSignInAvailable = async (): Promise<boolean> =>
  !isExpoGo && (await AppleAuthentication.isAvailableAsync().catch(() => false));

export async function getAppleCredential(): Promise<AppleCredential> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ERR_REQUEST_CANCELED') {
      throw new SignInCancelled();
    }
    throw e;
  }
  if (!credential.identityToken) throw new Error('Apple did not return an identity token');
  // Apple only returns the name on the very first authorization for this app.
  const fullName =
    [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ') ||
    undefined;
  return { identityToken: credential.identityToken, fullName };
}
