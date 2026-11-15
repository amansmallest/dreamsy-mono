import { useState } from 'react';
import { PlayOnPhone } from '../../components/PlayOnPhone';
import { Icon, Sparkle } from '../../components/Icon';
import { AuthedImg, Button, Chip, IconButton } from '../../components/ui';
import { api, errorMessage, type Game, type GameVersion } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { invalidate } from '../../lib/store';

export function PreviewCard({ game, versions, version, onVersion, building }: {
  game: Game;
  versions: GameVersion[];
  version: number;
  onVersion: (v: number) => void;
  building: boolean;
}) {
  const [phone, setPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = versions.find((x) => x.version === version);
  const isLiveVersion = game.status === 'published' && game.publishedVersion === version;
  const portrait = (game.orientation ?? 'portrait') === 'portrait';

  const publish = async () => {
    setBusy(true);
    try { await api.publish(game.id, version); invalidate(`game:${game.id}`); invalidate('games'); }
    catch (e) { alert(errorMessage(e)); } finally { setBusy(false); }
  };
  const unpublish = async () => {
    if (!confirm('Unpublish? The game disappears from feeds and its share link stops working.')) return;
    setBusy(true);
    try { await api.unpublish(game.id); invalidate(`game:${game.id}`); invalidate('games'); }
    catch (e) { alert(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="preview">
      <div className={`preview-frame ${portrait ? 'is-portrait' : 'is-landscape'}`}>
        {version > 0 ? (
          <AuthedImg key={version} url={api.thumbnailPath(game.id, version)} alt={`${game.name} v${version}`} className="preview-img"
            fallback={<div className="preview-empty"><Sparkle size={30} /><span className="label">No snapshot for v{version}</span></div>} />
        ) : (
          <div className="preview-empty">
            <Sparkle size={34} className={building ? 'spin-slow' : ''} />
            <span className="label">{building ? 'First version on its way' : 'No versions yet'}</span>
          </div>
        )}
        {isLiveVersion && <span className="preview-live"><Chip tone="ok">Live</Chip></span>}
      </div>

      {version > 0 && (
        <div className="version-switch">
          <IconButton icon="arrowLeft" label="Older version" disabled={version <= 1} onClick={() => onVersion(version - 1)} />
          <div className="version-switch-mid">
            <span className="version-num">v{version}</span>
            <span className="label muted">of {game.latestVersion}{v ? ` · ${timeAgo(v.createdAt)}` : ''}</span>
          </div>
          <IconButton icon="arrowRight" label="Newer version" disabled={version >= game.latestVersion} onClick={() => onVersion(version + 1)} />
        </div>
      )}
      {v?.summary && <p className="preview-summary">{v.summary}</p>}

      <div className="preview-actions">
        <Button size="lg" sparkles className="w-full" icon="phone" disabled={game.latestVersion === 0} onClick={() => setPhone(true)}>Play on phone</Button>
        {game.latestVersion > 0 && (isLiveVersion ? (
          <Button variant="outline" className="w-full" icon="check" disabled>Live · v{version}</Button>
        ) : (
          <Button variant="outline" className="w-full" icon="upload" busy={busy} onClick={publish}>
            {game.status === 'published' ? `Update live to v${version}` : `Publish v${version}`}
          </Button>
        ))}
        {game.status === 'published' && (
          <button className="link-btn center" onClick={unpublish}><Icon name="x" size={12} /> Unpublish</button>
        )}
      </div>
      {game.stats && game.status === 'published' && (
        <div className="stat-row">
          <div><b>{game.stats.plays}</b><span className="label">plays</span></div>
          <div><b>{game.stats.likes}</b><span className="label">likes</span></div>
          <div><b>{game.stats.remixes}</b><span className="label">remixes</span></div>
        </div>
      )}
      <PlayOnPhone game={game} open={phone} onClose={() => setPhone(false)} />
    </div>
  );
}
