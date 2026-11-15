import { useState } from 'react';
import { Logo } from '../components/Layout';
import { Icon, PixelSky } from '../components/Icon';
import { Button } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { env } from '../lib/env';

const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3zM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zM6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6L6.4 14zM12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z"/></svg>
);
const AppleA = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.6 1.3-.1 1.7-.8 3.3-.8 1.5 0 1.9.8 3.3.8 1.4 0 2.2-1.3 3-2.5.9-1.4 1.3-2.7 1.3-2.8 0 0-2.6-1-2.6-4.2zM13.9 5c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z"/></svg>
);

export function SignIn() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(auth.state.status === 'signedOut' ? auth.state.error ?? null : null);

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="signin">
      <PixelSky preset="panel" className="signin-hero">
        <Logo />
        <div className="signin-hero-copy">
          <h1 className="display">Dream it.<br />Build it.<br /><span className="blue">Play it.</span></h1>
          <p className="lead">Describe a game, watch it get built, then redraw any sprite until it's yours.</p>
        </div>
      </PixelSky>
      <section className="signin-pane">
        <div className="signin-form">
        <h2 className="h1">Sign in</h2>
        {auth.mode === 'supabase' ? (
          <>
            {auth.providers.google && (
              <Button variant="outline" size="lg" className="w-full" busy={busy === 'google'} onClick={run('google', () => auth.signInWithOAuth('google'))}>
                <GoogleG /> Continue with Google
              </Button>
            )}
            {auth.providers.apple && (
              <Button variant="outline" size="lg" className="w-full" busy={busy === 'apple'} onClick={run('apple', () => auth.signInWithOAuth('apple'))}>
                <AppleA /> Continue with Apple
              </Button>
            )}
            {auth.providers.email && (
              <>
                <div className="or"><span>or</span></div>
                {!sent ? (
                  <form className="stack" onSubmit={(e) => {
                    e.preventDefault();
                    const v = email.trim();
                    // Demo bypass: a username (no "@"), e.g. judge_demo, signs straight in.
                    if (!v.includes('@')) return void run('email', () => auth.demoSignIn(v))();
                    void run('email', async () => { await auth.sendEmailCode(v); setSent(true); })();
                  }}>
                    <input className="input" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" required placeholder="you@studio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <Button size="lg" className="w-full" busy={busy === 'email'} type="submit">Email me a code</Button>
                  </form>
                ) : (
                  <form className="stack" onSubmit={(e) => { e.preventDefault(); void run('verify', () => auth.verifyEmailCode(email.trim(), code.trim()))(); }}>
                    <p className="small muted row-icon"><Icon name="mail" size={15} /><span>We sent a code and a magic link to <b>{email}</b>. Use either.</span></p>
                    <input className="input input-code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
                    <Button size="lg" className="w-full" busy={busy === 'verify'} type="submit" disabled={code.trim().length < 6}>Verify & enter</Button>
                    <button type="button" className="link-btn" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
                  </form>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <p className="small muted">Dev build without Supabase: you'll get a guest account on <code>{env.apiUrl}</code>.</p>
            <Button size="lg" className="w-full" busy={busy === 'guest'} onClick={run('guest', auth.continueAsGuest)}>Continue as guest</Button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <p className="tiny muted">Same account as the Dreamsy app.</p>
        </div>
      </section>
    </div>
  );
}
