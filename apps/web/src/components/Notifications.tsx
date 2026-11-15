import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, isEarning, isNotFound, type AppNotification, type NotificationKind } from '../lib/api';
import { coinsToUsd, compactCoins, timeAgo, usd } from '../lib/format';
import { invalidate } from '../lib/store';
import { Icon, type IconName } from './Icon';
import { Spinner } from './ui';

const POLL_MS = 30_000;
const TOAST_MS = 6_000;

const KIND_ICON: Record<string, IconName> = {
  play_earning: 'coin',
  remix_earning: 'remix',
  royalty: 'coin',
  sale: 'coin',
  build_done: 'check',
  group_join: 'users',
};
const iconFor = (k: NotificationKind): IconName => KIND_ICON[k] ?? 'bell';

/** Where clicking a notification goes: the game workspace or the group page. */
function hrefFor(n: AppNotification): string | null {
  const d = n.data ?? {};
  if (typeof d.groupId === 'string') return `/groups?g=${encodeURIComponent(d.groupId)}`;
  if (typeof d.gameId === 'string') {
    const v = n.kind === 'build_done' && typeof d.version === 'number' ? `?v=${d.version}` : '';
    return `/games/${encodeURIComponent(d.gameId)}${v}`;
  }
  return null;
}

/** "You got paid · +9K coins · $0.09" (falls back to the server copy when coins are missing). */
function paidLine(n: AppNotification): string {
  const c = n.data?.coins;
  if (typeof c === 'number' && c > 0) return `${n.title || 'You got paid'} · +${compactCoins(c)} coins · ${usd(coinsToUsd(c))}`;
  return n.title || 'You got paid';
}

/**
 * Top-bar bell: unread badge (polled every 30 s + on focus), dropdown list, "Mark all read",
 * and a bottom-right "You got paid" toast when a new earning lands. Renders nothing on an API without notifications (404).
 */
export function NotificationBell() {
  const [supported, setSupported] = useState(true);
  const [unread, setUnread] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<AppNotification | null>(null);
  const prevUnread = useRef<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.notifications(null, 20);
      setItems(r.items);
      setNext(r.next);
      setUnread(r.unread);
      return r;
    } catch (e) {
      if (isNotFound(e)) setSupported(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const poll = useCallback(async () => {
    let n: number;
    try {
      n = (await api.unreadNotifications()).unread;
    } catch (e) {
      if (isNotFound(e)) setSupported(false);
      return;
    }
    const prev = prevUnread.current;
    prevUnread.current = n;
    setUnread(n);
    if (prev == null || n <= prev) return;
    // Something new arrived: refresh the list and toast if the newest one is money.
    const r = await api.notifications(null, 20).catch(() => null);
    if (!r) return;
    setItems(r.items);
    setNext(r.next);
    const newest = r.items[0];
    if (newest && !newest.read && isEarning(newest.kind)) {
      setToast(newest);
      invalidate('wallet');
    }
  }, []);

  // Poll every 30 s and whenever the tab regains focus.
  useEffect(() => {
    if (!supported) return;
    void poll();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, POLL_MS);
    const onFocus = () => void poll();
    const onVis = () => { if (document.visibilityState === 'visible') void poll(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis); };
  }, [supported, poll]);

  // Close the panel on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const toggle = () => {
    const o = !open;
    setOpen(o);
    if (o) void loadList();
  };

  const loadMore = async () => {
    if (!next) return;
    setLoading(true);
    try {
      const r = await api.notifications(next, 20);
      setItems((p) => [...(p ?? []), ...r.items.filter((x) => !p?.some((y) => y.id === x.id))]);
      setNext(r.next);
    } catch { /* keep what we have */ } finally { setLoading(false); }
  };

  const markRead = async (body: { ids?: string[]; all?: boolean }) => {
    setItems((p) => p?.map((n) => (body.all || body.ids?.includes(n.id) ? { ...n, read: true } : n)) ?? p);
    try {
      const r = await api.markNotificationsRead(body);
      setUnread(r.unread);
      prevUnread.current = r.unread;
    } catch { /* next poll reconciles */ }
  };

  const openItem = (n: AppNotification) => {
    if (!n.read) void markRead({ ids: [n.id] });
    const href = hrefFor(n);
    setOpen(false);
    if (href) nav(href);
  };

  if (!supported) return null;
  const count = unread ?? 0;

  return (
    <div className="notif" ref={wrap}>
      <button className={`icon-btn ghost notif-bell ${open ? 'is-active' : ''}`} onClick={toggle}
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'} title="Notifications" aria-expanded={open}>
        <Icon name="bell" size={19} />
        {count > 0 && <span className="notif-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <h3>Notifications</h3>
            <button className="link-btn" disabled={!count} onClick={() => void markRead({ all: true })}>Mark all read</button>
          </div>
          <div className="notif-list">
            {items == null ? <div className="notif-empty"><Spinner /></div>
              : items.length === 0 ? <div className="notif-empty muted">Nothing yet. Payouts, finished builds and group joins show up here.</div>
              : items.map((n) => (
                <button key={n.id} className={`notif-item ${n.read ? '' : 'is-unread'} ${isEarning(n.kind) ? 'is-earning' : ''}`} onClick={() => openItem(n)}>
                  <span className="notif-icon"><Icon name={iconFor(n.kind)} size={16} /></span>
                  <span className="notif-text">
                    <b>{n.title}</b>
                    <span>{n.body}</span>
                    <time className="muted">{timeAgo(n.createdAt)}</time>
                  </span>
                  {!n.read && <span className="notif-dot" aria-label="Unread" />}
                </button>
              ))}
            {next && items && (
              <button className="notif-more link-btn" onClick={() => void loadMore()} disabled={loading}>
                {loading ? <Spinner size={14} /> : 'Load more'}
              </button>
            )}
          </div>
        </div>
      )}
      {toast && createPortal(
        <div className="paid-toast" role="status" aria-live="polite">
          <button className="paid-toast-body" onClick={() => { setToast(null); openItem(toast); }}>
            <span className="paid-toast-icon"><Icon name="coin" size={18} /></span>
            <span className="paid-toast-text">
              <b>{paidLine(toast)}</b>
              {toast.body && <span>{toast.body}</span>}
            </span>
          </button>
          <button className="paid-toast-x" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="x" size={14} /></button>
        </div>,
        document.body,
      )}
    </div>
  );
}
