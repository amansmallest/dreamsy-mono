import { useState } from 'react';
import { Button, Chip, Empty } from '../../components/ui';
import { api, errorMessage, type Game, type GameVersion } from '../../lib/api';
import { bytes, timeAgo } from '../../lib/format';
import { invalidate } from '../../lib/store';

export function VersionsList({ game, versions, selected, onSelect, building }: {
  game: Game; versions: GameVersion[]; selected: number; onSelect: (v: number) => void; building: boolean;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  if (!versions.length) return <Empty title="No versions yet" body="Every build or edit commits a new, immutable version here." />;
  return (
    <ol className="versions">
      {versions.map((v) => {
        const live = game.status === 'published' && game.publishedVersion === v.version;
        return (
          <li key={v.version} className={`version ${v.version === selected ? 'is-selected' : ''}`}>
            <button className="version-main" onClick={() => onSelect(v.version)}>
              <span className="version-badge">v{v.version}</span>
              <span className="version-text">
                <span className="version-summary">{v.summary || (v.generationId ? 'Build' : 'Manual version')}</span>
                <span className="label muted">{timeAgo(v.createdAt)} · {bytes(v.sizeBytes)}</span>
              </span>
            </button>
            <div className="version-side">
              {live && <Chip tone="ok">Live</Chip>}
              {v.version === game.latestVersion && <Chip>Latest</Chip>}
              {v.version !== game.latestVersion && (
                <Button size="sm" variant="ghost" icon="refresh" busy={busy === v.version} disabled={building}
                  title={building ? 'Wait for the current build' : 'Make this the latest version'}
                  onClick={async () => {
                    setBusy(v.version);
                    try {
                      const r = await api.revert(game.id, v.version);
                      invalidate(`game:${game.id}`); invalidate(`versions:${game.id}`); invalidate('games');
                      onSelect(r.version.version);
                    } catch (e) { alert(errorMessage(e)); } finally { setBusy(null); }
                  }}>Restore</Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
