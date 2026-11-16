import { useState } from 'react';
import { Logo } from '../components/Layout';
import { Icon, PixelSky } from '../components/Icon';
import { Button } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { env } from '../lib/env';


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
            {auth.providers.email && (
              <>
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
                    <p className="small muted row-icon"><Icon name="mail" size={15} /><span>We sent a 6-digit code to <b>{email}</b>. It expires in 10 minutes.</span></p>
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
