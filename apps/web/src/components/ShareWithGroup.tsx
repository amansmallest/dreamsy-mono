import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { Button, Empty, ErrorNote, Modal, Spinner } from './ui';
import { api, errorMessage } from '../lib/api';
import { invalidate, useResource } from '../lib/store';

/** Pick one of my groups and share this game with it (drafts included, docs/platform.md §13). */
export function ShareWithGroupModal({ gameId, gameName, open, onClose }: { gameId: string; gameName: string; open: boolean; onClose: () => void }) {
  const groups = useResource(open ? 'groups' : null, api.myGroups);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const list = groups.data?.groups ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Share with a group" width={460}>
      <div className="stack">
        <p className="small muted">Members can play <b>{gameName}</b> and race on its leaderboard — even while it's a draft.</p>
        {groups.error ? <ErrorNote error={groups.error} onRetry={groups.refetch} />
          : !groups.data ? <div className="center-page" style={{ minHeight: 80 }}><Spinner /></div>
          : list.length === 0 ? (
            <Empty compact title="No groups yet" body="Make a family or friends group first." action={<Link to="/groups" className="link-btn" onClick={onClose}>Go to Groups</Link>} />
          ) : (
            <ul className="pick-list">
              {list.map((g) => (
                <li key={g.id}>
                  <span className="pick-icon"><Icon name="users" size={16} /></span>
                  <span className="pick-text"><b>{g.name}</b><span className="tiny muted">{g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</span></span>
                  {done[g.id] ? <span className="small ok row-icon"><Icon name="check" size={14} /> Shared</span> : (
                    <Button size="sm" variant="outline" icon="share" busy={busy === g.id} onClick={async () => {
                      setBusy(g.id); setError(null);
                      try {
                        await api.shareGame(g.id, gameId);
                        setDone((d) => ({ ...d, [g.id]: true }));
                        invalidate(`groupGames:${g.id}`);
                      } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
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
