import { useCallback, useState } from 'react';
import { PlayOnPhone, QrCode } from '../../components/PlayOnPhone';
import { PlayInStudio } from '../../components/PlayInStudio';
import { Icon, PixelCloud } from '../../components/Icon';
import { BuildRing } from '../../components/GameCard';
import { AuthedImg, Button, Chip, IconButton, Segmented } from '../../components/ui';
import { api, errorMessage, type Game, type GameVersion, type Visibility } from '../../lib/api';
import { deepLink } from '../../lib/env';
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
  const [playing, setPlaying] = useState(false);
  const closePlay = useCallback(() => setPlaying(false), []);
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

  const setVisibility = async (next: Visibility) => {
    if (next === game.visibility) return;
    if (next === 'private' && game.status === 'published'
      && !confirm('Make private? The game leaves feeds and its share link stops working.')) return;
    setBusy(true);
    try { await api.setVisibility(game.id, next); invalidate(`game:${game.id}`); invalidate('games'); }
    catch (e) { alert(errorMessage(e)); } finally { setBusy(false); }
  };
  // Older APIs don't send `visibility`: keep the explicit Publish/Unpublish UI there.
  const hasVisibility = game.visibility !== undefined;
  const isPublic = game.visibility === 'public';

  return (
    <div className="preview card">
      <div className={`preview-frame ${portrait ? 'is-portrait' : 'is-landscape'}`}>
        {version > 0 ? (
          <AuthedImg key={version} url={api.thumbnailPath(game.id, version)} alt={`${game.name} v${version}`} className="preview-img" pixelated
            fallback={<div className="preview-empty"><PixelCloud variant="a" px={5} className="drift" /><span>No snapshot for v{version}</span></div>} />
        ) : (
          <div className="preview-empty">
            {building ? <BuildRing size={44} /> : <PixelCloud variant="a" px={5} className="drift" />}
            <span>{building ? 'First version on its way' : 'No versions yet'}</span>
          </div>
        )}
        {version > 0 && <button className="preview-play-hit" aria-label={`Play v${version}`} onClick={() => setPlaying(true)} />}
        <span className="preview-badges">
          {isLiveVersion && <Chip tone="ok">Live</Chip>}
          {building && <Chip tone="live">Building</Chip>}
        </span>
      </div>

      {version > 0 && (
        <div className="version-switch">
          <IconButton icon="chevronLeft" label="Older version" className="sm ghost" disabled={version <= 1} onClick={() => onVersion(version - 1)} />
          <div className="version-switch-mid">
            <span className="version-num">v{version}</span>
            <span className="version-of">of {game.latestVersion}{v ? ` · ${timeAgo(v.createdAt)}` : ''}</span>
          </div>
          <IconButton icon="chevronRight" label="Newer version" className="sm ghost" disabled={version >= game.latestVersion} onClick={() => onVersion(version + 1)} />
        </div>
      )}
      {v?.summary && <p className="preview-summary">{v.summary}</p>}

      <div className="preview-actions">
        {version > 0 && (
          <Button size="lg" className="w-full" icon="play" onClick={() => setPlaying(true)}>Play v{version}</Button>
        )}
        {hasVisibility ? (
          <div className="visibility">
            <Segmented<Visibility> value={game.visibility!} onChange={(v) => { if (!busy) void setVisibility(v); }}
              options={[{ value: 'public', label: 'Public' }, { value: 'private', label: 'Private' }]} />
            <p className="visibility-hint">
              {isPublic ? 'Public: everyone can play the newest version' : 'Private: only you (and groups you share with)'}
            </p>
            {isPublic && version > 0 && !isLiveVersion && (
              <Button variant="outline" className="w-full" icon="upload" busy={busy} onClick={publish}>Make v{version} live</Button>
            )}
          </div>
        ) : game.latestVersion > 0 && (isLiveVersion ? (
          <Button variant="outline" className="w-full" icon="check" disabled>Live · v{version}</Button>
        ) : (
          <Button className="w-full" icon="upload" busy={busy} onClick={publish}>
            {game.status === 'published' ? `Update live to v${version}` : `Publish v${version}`}
          </Button>
        ))}
        <button className="qr-card" disabled={game.latestVersion === 0} onClick={() => setPhone(true)}>
          <QrCode value={deepLink(game.id)} size={56} />
          <span className="qr-card-text">
            <b>Play on phone</b>
            <span>Scan to open in the app</span>
          </span>
          <Icon name="chevronRight" size={18} className="muted" />
        </button>
        {!hasVisibility && game.status === 'published' && (
          <button className="link-btn danger center" onClick={unpublish}>Unpublish</button>
        )}
      </div>
      {game.stats && game.status === 'published' && (
        <div className="stat-row">
          <div><b>{game.stats.plays.toLocaleString()}</b><span>plays</span></div>
          <div><b>{game.stats.likes.toLocaleString()}</b><span>likes</span></div>
          <div><b>{game.stats.remixes.toLocaleString()}</b><span>spin-offs</span></div>
        </div>
      )}
      <PlayOnPhone game={game} open={phone} onClose={() => setPhone(false)} />
      {version > 0 && <PlayInStudio game={game} version={version} open={playing} onClose={closePlay} />}
    </div>
  );
}
