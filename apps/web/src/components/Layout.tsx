import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useResource } from '../lib/store';
import { Icon, Sparkle } from './Icon';

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Dreamsy home">
      <span className="logo-mark"><Sparkle size={16} /></span>
      <span className="logo-word">dreamsy</span>
      <span className="logo-tag label">studio</span>
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
  const q = quota.data?.quota;
  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <nav className="nav">
          <NavLink to="/" end className="nav-link"><Icon name="grid" size={16} />Games</NavLink>
          <NavLink to="/activity" className="nav-link"><Icon name="history" size={16} />Activity</NavLink>
          <NavLink to="/insights" className="nav-link"><Icon name="star" size={16} />Insights</NavLink>
          <NavLink to="/account" className="nav-link"><Icon name="user" size={16} />Account</NavLink>
        </nav>
        <div className="topbar-right">
          {q && (
            <Link to="/account" className="quota-chip" title="Builds left today">
              <Icon name="bolt" size={14} />
              <b>{q.remaining}</b><span>/{q.limit} builds</span>
            </Link>
          )}
          <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          {user && <Link to="/account" className="avatar" title={`@${user.handle}`}>{user.handle.charAt(0).toUpperCase()}</Link>}
        </div>
      </header>
      <main className="main"><Outlet /></main>
    </div>
  );
}
