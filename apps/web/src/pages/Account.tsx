import { useEffect, useState } from 'react';
import { Icon, Sparkle } from '../components/Icon';
import { Button, ErrorNote, ProgressPill, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth, useUser } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { invalidate, useResource } from '../lib/store';

const LEDGER: Record<string, string> = { starter_grant: 'Welcome gift', purchase: 'Purchase', sale: 'Sale' };

export function Account() {
  const user = useUser();
  const auth = useAuth();
  const quota = useResource('quota', api.quota);
  const wallet = useResource('wallet', api.wallet);
  const [handle, setHandle] = useState(user.handle);
  const [bio, setBio] = useState(user.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setHandle(user.handle); setBio(user.bio ?? ''); }, [user]);
  const dirty = handle !== user.handle || bio !== (user.bio ?? '');
  const handleOk = /^[a-z0-9_]{3,20}$/.test(handle);
  const q = quota.data?.quota;

  return (
    <div className="page narrow">
      <section className="hero compact">
        <div>
          <span className="label">Signed in{auth.mode === 'guest' ? ' as guest' : ''}</span>
          <h1 className="display">Account</h1>
        </div>
        <Button variant="outline" icon="logout" onClick={() => auth.signOut()}>Sign out</Button>
      </section>

      <div className="account-grid">
        <section className="card profile-card">
          <div className="profile-head">
            <div className="avatar xl">{handle.charAt(0).toUpperCase() || '?'}</div>
            <div>
              <h2 className="h2">@{user.handle}</h2>
              <span className="label muted">Creator since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            </div>
          </div>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true); setMsg(null);
            try {
              const body: { handle?: string; bio?: string } = {};
              if (handle !== user.handle) body.handle = handle;
              if (bio !== (user.bio ?? '')) body.bio = bio;
              const { user: u } = await api.updateMe(body);
              auth.setUser(u);
              setMsg({ ok: true, text: 'Saved' });
            } catch (err) { setMsg({ ok: false, text: errorMessage(err) }); } finally { setSaving(false); }
          }}>
            <label className="field">
              <span className="label">Handle</span>
              <div className="input-prefix"><span>@</span><input className="input" value={handle} maxLength={20} onChange={(e) => setHandle(e.target.value.toLowerCase())} /></div>
              {!handleOk && <span className="tiny danger">3–20 characters: a–z, 0–9, _</span>}
            </label>
            <label className="field">
              <span className="label">Bio <span className="muted">{bio.length}/280</span></span>
              <textarea className="input" rows={3} maxLength={280} value={bio} placeholder="What do you like to build?" onChange={(e) => setBio(e.target.value)} />
            </label>
            <div className="row">
              <Button sparkles busy={saving} disabled={!dirty || !handleOk} type="submit">Save profile</Button>
              {msg && <span className={`small ${msg.ok ? 'ok' : 'danger'}`}>{msg.text}</span>}
            </div>
          </form>
        </section>

        <section className="card quota-card">
          <span className="label">Builds today</span>
          {quota.error ? <ErrorNote error={quota.error} onRetry={quota.refetch} /> : !q ? <Spinner /> : (
            <>
              <div className="big-num"><b>{q.remaining}</b><span>of {q.limit} left</span></div>
              <ProgressPill value={q.used / Math.max(1, q.limit)} />
              <p className="small muted">{q.resetsAt ? <>Next build frees up {timeAgo(q.resetsAt).replace(' ago', '') === 'just now' ? 'soon' : `at ${new Date(q.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</> : 'Rolling 24-hour window.'}</p>
            </>
          )}
        </section>

        <section className="card wallet-card">
          <div className="wallet-head">
            <span className="label">Stars wallet</span>
            <Sparkle size={18} />
          </div>
          {wallet.error ? <ErrorNote error={wallet.error} onRetry={wallet.refetch} /> : !wallet.data ? <Spinner /> : (
            <>
              <div className="big-num"><b>{wallet.data.wallet.balance.toLocaleString()}</b><span>stars</span></div>
              <ol className="ledger">
                {wallet.data.recent.length === 0 && <li className="muted small">No transactions yet.</li>}
                {wallet.data.recent.map((e, i) => (
                  <li key={i}>
                    <span className={`ledger-delta ${e.delta >= 0 ? 'pos' : 'neg'}`}>{e.delta >= 0 ? '+' : '−'}{Math.abs(e.delta)}</span>
                    <span className="ledger-kind">{LEDGER[e.kind] ?? e.kind}{e.itemId ? ` · ${e.itemId}` : ''}</span>
                    <span className="label muted">{timeAgo(e.createdAt)}</span>
                  </li>
                ))}
              </ol>
              <button className="link-btn" onClick={() => { invalidate('wallet'); }}><Icon name="refresh" size={12} /> Refresh</button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
