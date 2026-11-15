import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Avatar, Button, Chip, Empty, ErrorNote, Modal, Spinner } from '../components/ui';
import { api, errorMessage, type Group } from '../lib/api';
import { useUser } from '../lib/auth';
import { inviteLink, timeAgo } from '../lib/format';
import { invalidate, useResource } from '../lib/store';

/** Family / friends groups (DREAMSY.MD §13): invite by code, shared games, group leaderboards. */
export function Groups() {
  const groups = useResource('groups', api.myGroups);
  const [params, setParams] = useSearchParams();
  const list = groups.data?.groups ?? [];
  const selectedId = params.get('g') ?? list[0]?.id ?? null;
  const selected = list.find((g) => g.id === selectedId) ?? null;
  const select = (id: string | null) => setParams(id ? { g: id } : {}, { replace: true });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="kicker">play together</span>
          <h1 className="h1">Groups</h1>
          <p className="muted small groups-lede">Share games (even drafts) with family and friends, and race each other on group leaderboards.</p>
        </div>
      </div>

      <div className="groups-grid">
        <div className="groups-side">
          <CreateGroup onCreated={(g) => select(g.id)} />
          <JoinByCode onJoined={(g) => select(g.id)} />
          <section className="card groups-list-card">
            <span className="kicker">My groups</span>
            {groups.error ? <ErrorNote error={groups.error} onRetry={groups.refetch} />
              : !groups.data ? <div className="skeleton skel-line" />
              : list.length === 0 ? <p className="small muted">No groups yet.</p>
              : (
                <ul className="group-list">
                  {list.map((g) => (
                    <li key={g.id}>
                      <button className={`group-item ${g.id === selected?.id ? 'is-selected' : ''}`} onClick={() => select(g.id)}>
                        <span className="pick-icon"><Icon name="users" size={16} /></span>
                        <span className="pick-text"><b>{g.name}</b><span className="tiny muted">{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</span></span>
                        {g.role === 'owner' && <Chip>Owner</Chip>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>

        <div className="groups-main">
          {selected ? <GroupDetail key={selected.id} group={selected} onGone={() => select(null)} />
            : groups.data && <Empty title="Make your first group" body="Create one for your family or friends, then send them the invite link." />}
        </div>
      </div>
    </div>
  );
}

function CreateGroup({ onCreated }: { onCreated: (g: Group) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card groups-form-card">
      <span className="kicker">New group</span>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true); setError(null);
        try {
          const { group } = await api.createGroup(name.trim());
          setName('');
          invalidate('groups');
          onCreated(group);
        } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>
        <input className="input" value={name} maxLength={60} placeholder="The Singh family" onChange={(e) => setName(e.target.value)} aria-label="Group name" />
        <Button type="submit" icon="plus" busy={busy} disabled={!name.trim()}>Create</Button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function JoinByCode({ onJoined }: { onJoined: (g: Group) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <section className="card groups-form-card">
      <span className="kicker">Join with a code</span>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
          const { group } = await api.joinGroup(clean);
          setCode('');
          invalidate('groups');
          onJoined(group);
        } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>
        <input className="input input-invite" value={code} maxLength={12} placeholder="ABCD2345" onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Invite code" />
        <Button type="submit" variant="outline" busy={busy} disabled={clean.length !== 8}>Join</Button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button size="sm" variant="outline" icon={copied ? 'check' : 'copy'} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { window.prompt('Copy this link', text); }
    }}>{copied ? 'Copied' : label}</Button>
  );
}

function GroupDetail({ group, onGone }: { group: Group; onGone: () => void }) {
  const me = useUser();
  const detail = useResource(`group:${group.id}`, () => api.group(group.id));
  const shared = useResource(`groupGames:${group.id}`, () => api.groupGames(group.id));
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isOwner = group.ownerId === me.id;
  const code = detail.data?.group.inviteCode ?? group.inviteCode;
  const link = inviteLink(code);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try { await fn(); } catch (e) { alert(errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="group-detail">
      <section className="card group-head-card">
        <div className="group-head">
          <h2 className="h2">{group.name}</h2>
          <span className="muted small">{group.memberCount} / 50 members</span>
        </div>
        <div className="invite">
          <span className="kicker">Invite link</span>
          <div className="invite-row">
            <code className="invite-link">{link}</code>
            <CopyButton text={link} />
          </div>
          <div className="invite-row">
            <span className="small muted">Code <b className="invite-code">{code}</b></span>
            {isOwner && (
              <button className="link-btn small" disabled={busy === 'rotate'} onClick={() => {
                if (!confirm('Make a new invite code? The old link stops working.')) return;
                void act('rotate', async () => { await api.rotateInvite(group.id); invalidate(`group:${group.id}`); invalidate('groups'); });
              }}>New code</button>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="section-head compact">
          <h3 className="h3">Shared games</h3>
          <Button size="sm" icon="share" onClick={() => setSharing(true)}>Share a game</Button>
        </div>
        {shared.error ? <ErrorNote error={shared.error} onRetry={shared.refetch} />
          : !shared.data ? <div className="skeleton skel-line" />
          : shared.data.games.length === 0 ? <p className="small muted">Nothing shared yet. Share one of your games — drafts work too.</p>
          : (
            <ul className="shared-list">
              {shared.data.games.map((g) => {
                const canUnshare = g.sharedBy.id === me.id || g.ownerId === me.id || isOwner;
                return (
                  <li key={g.id} className="shared-item">
                    <span className="shared-text">
                      {g.ownerId === me.id ? <Link to={`/games/${g.id}`} className="shared-name">{g.name}</Link> : <b className="shared-name">{g.name}</b>}
                      <span className="tiny muted">by @{g.creator?.handle ?? '?'} · shared by @{g.sharedBy.handle} {timeAgo(g.sharedAt)}</span>
                    </span>
                    {g.status === 'published' ? <Chip tone="ok">Live</Chip> : <Chip>Draft</Chip>}
                    {canUnshare && (
                      <button className="icon-btn sm ghost" aria-label="Unshare" title="Unshare" disabled={busy === g.id}
                        onClick={() => act(g.id, async () => { await api.unshareGame(group.id, g.id); invalidate(`groupGames:${group.id}`); })}>
                        <Icon name="x" size={15} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </section>

      <section className="card">
        <h3 className="h3 card-title">Members</h3>
        {detail.error ? <ErrorNote error={detail.error} onRetry={detail.refetch} />
          : !detail.data ? <div className="skeleton skel-line" />
          : (
            <ul className="member-list">
              {detail.data.members.map((m) => (
                <li key={m.user.id}>
                  <Avatar handle={m.user.handle} size="sm" />
                  <span className="member-name">@{m.user.handle}{m.user.id === me.id && <span className="muted"> (you)</span>}</span>
                  {m.role === 'owner' && <Chip>Owner</Chip>}
                  <span className="tiny muted push">joined {timeAgo(m.joinedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        <div className="row group-actions">
          <Button size="sm" variant="ghost" icon="logout" busy={busy === 'leave'} onClick={() => {
            if (!confirm(isOwner ? `Leave ${group.name}? Ownership passes to the longest-standing member.` : `Leave ${group.name}?`)) return;
            void act('leave', async () => { await api.leaveGroup(group.id); invalidate('groups'); onGone(); });
          }}>Leave group</Button>
          {isOwner && (
            <Button size="sm" variant="danger" icon="trash" busy={busy === 'delete'} onClick={() => {
              if (!confirm(`Delete ${group.name} for everyone?`)) return;
              void act('delete', async () => { await api.deleteGroup(group.id); invalidate('groups'); onGone(); });
            }}>Delete group</Button>
          )}
        </div>
      </section>

      <ShareGameModal open={sharing} onClose={() => setSharing(false)} groupId={group.id} sharedIds={new Set(shared.data?.games.map((g) => g.id) ?? [])} />
    </div>
  );
}

function ShareGameModal({ open, onClose, groupId, sharedIds }: { open: boolean; onClose: () => void; groupId: string; sharedIds: Set<string> }) {
  const games = useResource(open ? 'games' : null, api.myGames);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = (games.data?.games ?? []).filter((g) => g.latestVersion > 0);
  return (
    <Modal open={open} onClose={onClose} title="Share a game" width={480}>
      <div className="stack">
        {games.error ? <ErrorNote error={games.error} onRetry={games.refetch} />
          : !games.data ? <div className="center-page" style={{ minHeight: 80 }}><Spinner /></div>
          : list.length === 0 ? <p className="small muted">Build a game first — then share it here.</p>
          : (
            <ul className="pick-list scroll">
              {list.map((g) => (
                <li key={g.id}>
                  <span className="pick-text"><b>{g.name}</b><span className="tiny muted">{g.status === 'published' ? 'Live' : 'Draft'} · v{g.latestVersion}</span></span>
                  {sharedIds.has(g.id) ? <span className="small ok row-icon"><Icon name="check" size={14} /> Shared</span> : (
                    <Button size="sm" variant="outline" icon="share" busy={busy === g.id} onClick={async () => {
                      setBusy(g.id); setError(null);
                      try { await api.shareGame(groupId, g.id); invalidate(`groupGames:${groupId}`); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
                    }}>Share</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

/** /join/:code — joins as soon as the user is signed in (the sign-in gate keeps the URL), then opens the group. */
export function JoinGroup() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api.joinGroup(code).then(({ group }) => {
      if (!live) return;
      invalidate('groups');
      navigate(`/groups?g=${encodeURIComponent(group.id)}`, { replace: true });
    }, (e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [code, navigate]);
  return (
    <div className="page narrow center-page">
      {error ? (
        <Empty title="Couldn't join" body={errorMessage(error)} action={<Link to="/groups" className="link-btn">Go to Groups</Link>} />
      ) : <div className="row-icon muted"><Spinner size={20} /> Joining group…</div>}
    </div>
  );
}
