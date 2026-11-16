import type { AppleCredential } from './types';

// Web (PWA): no Sign in with Apple; the button stays hidden (app/sign-in.tsx asks only on iOS).

/** User dismissed the sign-in sheet. Callers should ignore it silently. */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

export const isAppleSignInAvailable = async (): Promise<boolean> => false;

export async function getAppleCredential(): Promise<AppleCredential> {
  throw new Error('Sign in with Apple is only in the iPhone app');
}
