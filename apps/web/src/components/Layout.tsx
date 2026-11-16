import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { coinsToUsd, compactCoins, usd } from '../lib/format';
import { invalidate, useResource } from '../lib/store';
import { Icon, Sparkle } from './Icon';
import { NotificationBell } from './Notifications';
import { Onboarding } from './Onboarding';
import { Avatar } from './ui';

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Dreamsy home">
      <Sparkle size={20} className="logo-mark" />
      <span className="logo-word">dreamsy</span>
      <span className="logo-tag">studio</span>
    </Link>
  );
}

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dreamsy.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function Layout() {
  const { state } = useAuth();
  const quota = useResource('quota', api.quota);
  const [theme, toggle] = useTheme();
  const user = state.status === 'signedIn' ? state.user : null;
  const wallet = useResource('wallet', api.wallet);
  // Balance moves when plays happen in the app; refresh when the tab regains focus.
  useEffect(() => {
    const onFocus = () => invalidate('wallet');
    const onVis = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const q = quota.data?.quota;
  const w = wallet.data?.wallet;
  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <nav className="nav">
          <NavLink to="/" end className="nav-link">Games</NavLink>
          <NavLink to="/explore" className="nav-link">Explore</NavLink>
          <NavLink to="/activity" className="nav-link">Activity</NavLink>
          <NavLink to="/groups" className="nav-link">Groups</NavLink>
          <NavLink to="/insights" className="nav-link">Insights</NavLink>
          <NavLink to="/account" className="nav-link">Account</NavLink>
        </nav>
        <div className="topbar-right">
          {q && (
            <Link to="/account" className="quota-chip" title="Builds left today">
              <Icon name="bolt" size={14} />
              <b>{q.remaining}</b><span>/ {q.limit} builds</span>
            </Link>
          )}
          {w && (
            <Link to="/account" className="quota-chip coin-chip" title={`${w.balance.toLocaleString()} coins`}>
              <Icon name="coin" size={14} />
              <b>{compactCoins(w.balance)}</b><span>coins · {usd(w.usd ?? coinsToUsd(w.balance))}</span>
            </Link>
          )}
          {user && <NotificationBell />}
          <button className="icon-btn ghost" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
          </button>
          {user && <Link to="/account" className="topbar-avatar" title={`@${user.handle}`}><Avatar handle={user.handle} /></Link>}
        </div>
      </header>
      <main className="main"><Outlet /></main>
      {user && <Onboarding />}
    </div>
  );
}
