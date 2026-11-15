import { useEffect, useState } from 'react';
import { Icon, Sparkle } from '../components/Icon';
import { Avatar, Button, Chip, ErrorNote, ProgressPill } from '../components/ui';
import { Link } from 'react-router-dom';
import { api, errorMessage, isNotFound } from '../lib/api';
import { useAuth, useUser } from '../lib/auth';
import { coins, coinsToUsd, compactCoins, timeAgo, usd } from '../lib/format';
import { invalidate, useResource } from '../lib/store';

const LEDGER: Record<string, string> = {
  starter_grant: 'Welcome gift', grant: 'Gift', purchase: 'Purchase', sale: 'Sale',
  play: 'Played', play_earning: 'Play earnings',
};
const ledgerLabel = (kind: string) => LEDGER[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function Account() {
  const user = useUser();
  const auth = useAuth();
  const quota = useResource('quota', api.quota);
  const wallet = useResource('wallet', api.wallet);
  const games = useResource('games', api.myGames);
  const earnings = useResource('earnings', api.earnings);
  const [handle, setHandle] = useState(user.handle);
  const [bio, setBio] = useState(user.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setHandle(user.handle); setBio(user.bio ?? ''); }, [user]);
  const dirty = handle !== user.handle || bio !== (user.bio ?? '');
  const handleOk = /^[a-z0-9_]{3,20}$/.test(handle);
  const q = quota.data?.quota;
  const list = games.data?.games;
  const sum = (k: 'plays' | 'likes') => list?.reduce((n, g) => n + (g.stats?.[k] ?? 0), 0);
  const stat = (n: number | undefined) => (n == null ? '—' : n.toLocaleString());
  const earn = earnings.data;
  const names = new Map([...(list ?? []).map((g) => [g.id, g.name] as const), ...(earn?.games ?? []).map((g) => [g.gameId, g.name] as const)]);
  const gameName = (id: string) => names.get(id) ?? 'a game';

  return (
    <div className="page narrow">
      <section className="profile">
        <Avatar handle={handle} size="xl" />
        <div className="profile-main">
          <div className="profile-top">
            <h1 className="h1">@{user.handle}</h1>
            {auth.mode === 'guest' && <Chip>Guest</Chip>}
            <Button variant="outline" size="sm" icon="logout" className="push" onClick={() => auth.signOut()}>Sign out</Button>
          </div>
          <div className="profile-stats">
            <span><b>{stat(list?.length)}</b> games</span>
            <span><b>{stat(list?.filter((g) => g.status === 'published').length)}</b> live</span>
            <span><b>{stat(sum('plays'))}</b> plays</span>
            <span><b>{stat(sum('likes'))}</b> likes</span>
          </div>
          {user.bio && <p className="profile-bio">{user.bio}</p>}
          <span className="profile-since">Creator since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        </div>
      </section>

      <div className="account-grid">
        <section className="card profile-card">
          <h2 className="h3">Edit profile</h2>
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
              <span className="field-label">Handle</span>
              <div className="input-prefix"><span>@</span><input className="input" value={handle} maxLength={20} onChange={(e) => setHandle(e.target.value.toLowerCase())} /></div>
              {!handleOk && <span className="tiny danger">3–20 characters: a–z, 0–9, _</span>}
            </label>
            <label className="field">
              <span className="field-label">Bio <span className="faint">{bio.length}/280</span></span>
              <textarea className="input" rows={3} maxLength={280} value={bio} placeholder="What do you like to build?" onChange={(e) => setBio(e.target.value)} />
            </label>
            <div className="row">
              <Button busy={saving} disabled={!dirty || !handleOk} type="submit">Save profile</Button>
              {msg && <span className={`small row-icon ${msg.ok ? 'ok' : 'danger'}`}>{msg.ok && <Icon name="check" size={14} />}{msg.text}</span>}
            </div>
          </form>
        </section>

        <div className="account-side">
          <section className="card quota-card">
            <span className="kicker">Builds today</span>
            {quota.error ? <ErrorNote error={quota.error} onRetry={quota.refetch} /> : !q ? <div className="skeleton skel-num" /> : (
              <>
                <div className="big-num"><b>{q.remaining}</b><span>of {q.limit} left</span></div>
                <ProgressPill value={q.used / Math.max(1, q.limit)} />
                <p className="small muted">{q.resetsAt ? <>Next build frees up {timeAgo(q.resetsAt).replace(' ago', '') === 'just now' ? 'soon' : `at ${new Date(q.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</> : 'Rolling 24-hour window.'}</p>
              </>
            )}
          </section>

          {!isNotFound(wallet.error) && (
            <section className="card wallet-card">
              <div className="wallet-head">
                <span className="kicker">Coins</span>
                <button className="icon-btn sm ghost" aria-label="Refresh wallet" title="Refresh" onClick={() => { invalidate('wallet'); invalidate('earnings'); }}><Icon name="refresh" size={15} /></button>
              </div>
              {wallet.error ? <ErrorNote error={wallet.error} onRetry={wallet.refetch} /> : !wallet.data ? <div className="skeleton skel-num" /> : (
                <>
                  <div className="big-num"><Icon name="coin" size={22} className="blue" /><b title={`${wallet.data.wallet.balance.toLocaleString()} coins`}>{compactCoins(wallet.data.wallet.balance)}</b><span>coins · {usd(wallet.data.wallet.usd ?? coinsToUsd(wallet.data.wallet.balance))}</span></div>
                  {earn && (
                    <Link to="/insights" className="earn-line">
                      <Sparkle size={11} className="blue" />
                      <span>Earned <b>{usd(earn.usd.total)}</b> · {coins(earn.totalCoins)} from {earn.paidPlays.toLocaleString()} paid {earn.paidPlays === 1 ? 'play' : 'plays'}{earn.todayCoins > 0 ? <> · <b>{usd(earn.usd.today)}</b> today</> : null}</span>
                      <Icon name="chevronRight" size={14} className="push" />
                    </Link>
                  )}
                  <p className="tiny muted">10,000 coins = $0.10. Playing someone else's game costs 10K coins; creators keep 90%.</p>
                  <ol className="ledger">
                    {wallet.data.recent.length === 0 && <li className="muted small">No transactions yet.</li>}
                    {wallet.data.recent.map((e, i) => (
                      <li key={i}>
                        <span className={`ledger-delta ${e.delta >= 0 ? 'pos' : 'neg'}`} title={`${e.delta.toLocaleString()} coins`}>{e.delta >= 0 ? '+' : '−'}{compactCoins(Math.abs(e.delta))}</span>
                        <span className="ledger-kind">{ledgerLabel(e.kind)}{e.gameId ? <span className="muted"> · {gameName(e.gameId)}</span> : e.itemId ? <span className="muted"> · {e.itemId}</span> : null}</span>
                        <span className="ledger-time">{timeAgo(e.createdAt)}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
