import { Redirect } from 'expo-router';

/**
 * Google OAuth returns to dreamsy://auth-callback. The auth sheet normally consumes that URL;
 * if the OS opens the app with it instead, just go home (the root layout routes by auth state).
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
