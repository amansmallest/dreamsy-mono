import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BuildEntry } from '../../components/BuildEntry';
import { Composer } from '../../components/Composer';
import { Icon, Sparkle } from '../../components/Icon';
import { ShareWithGroupModal } from '../../components/ShareWithGroup';
import { Empty, ErrorNote, Segmented, Spinner } from '../../components/ui';
import { MultiplayerChip } from '../../components/GameCard';
import { activeGenerationIdFrom, api, errorMessage, isActive, type Generation } from '../../lib/api';
import { useGenerationStream } from '../../lib/generation';
import { invalidate, setCached, useResource } from '../../lib/store';
import { AssetsPanel, type Edit } from './Assets';
import { LeaderboardPanel } from './Leaderboard';
import { PreviewCard } from './PreviewCard';
import { VersionsList } from './VersionsList';

const CHIPS = ['Make it harder', 'Add a boss fight', 'More juice & particles', 'Add a new level', 'Polish the art', 'Fix the controls'];

export function Workspace() {
  const { id = '' } = useParams();
  const game = useResource(`game:${id}`, () => api.game(id));
  const versions = useResource(`versions:${id}`, () => api.versions(id));
  const gens = useResource(`gens:${id}`, () => api.generations(id));
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'sprites' | 'versions' | 'leaderboard'>('sprites');
  const [sharing, setSharing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [composerError, setComposerError] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const toBottom = (smooth = false) => requestAnimationFrame(() => { const el = chatRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); });

  const g = game.data?.game;
  const list = gens.data?.generations ?? [];
  const activeGen: Generation | null = (g?.activeGeneration && isActive(g.activeGeneration.status) ? g.activeGeneration : null)
    ?? list.find((x) => isActive(x.status)) ?? null;
  const pinned = params.get('v');
  const version = pinned ? Number(pinned) : g?.latestVersion ?? 0;
  const selectVersion = useCallback((v: number) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set('v', String(v));
    return n;
  }, { replace: true }), [setParams]);
  const versionMeta = versions.data?.versions.find((v) => v.version === version);
  const pixelated = (versionMeta?.manifest?.style?.preset ?? 'pixel') === 'pixel';

  const refreshAll = useCallback(() => {
    invalidate(`game:${id}`); invalidate(`versions:${id}`); invalidate(`gens:${id}`); invalidate('games'); invalidate('quota'); invalidate('activity');
  }, [id]);

  const stream = useGenerationStream(activeGen, {
    onCheckpoint: (v) => { invalidate(`game:${id}`); invalidate(`versions:${id}`); if (!pinned) selectVersion(v); },
    onFinished: (fin) => {
      refreshAll();
      if (fin.status === 'succeeded' && fin.resultVersion) {
        selectVersion(fin.resultVersion);
        const ids = fin.assetIds ?? activeGen?.assetIds ?? [];
        if (ids.length) setEdits((e) => ({ ...e, ...Object.fromEntries(ids.map((a) => [a, { before: fin.baseVersion, after: fin.resultVersion! }])) }));
      }
    },
  });

  const onStarted = useCallback((gen: Generation) => {
    setCached<{ generations: Generation[] }>(`gens:${id}`, (p) => ({ generations: [gen, ...(p?.generations ?? []).filter((x) => x.id !== gen.id)] }));
    setCached<{ game: NonNullable<typeof g> }>(`game:${id}`, (p) => (p ? { game: { ...p.game, activeGeneration: gen } } : p!));
    invalidate('quota'); invalidate('games');
    nearBottom.current = true;
    setTimeout(() => toBottom(true), 50);
  }, [id]);

  // Follow new messages and live events while the user is at the bottom.
  const count = list.length;
  const evCount = stream?.events.length ?? 0;
  useEffect(() => { if (nearBottom.current) toBottom(); }, [count, evCount, id, !!g]); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = useMemo(() => [...list].reverse(), [list]);

  if (game.error) return <div className="page"><ErrorNote error={game.error} onRetry={game.refetch} /></div>;
  if (!g) return <div className="page center-page"><Spinner size={28} /></div>;

  return (
    <div className={`ws ${expanded ? 'is-expanded' : ''}`}>
      <aside className="ws-left">
        <div className="ws-title">
          <Link to="/" className="icon-btn sm ghost" aria-label="Back to games"><Icon name="chevronLeft" size={18} /></Link>
          <GameName id={id} name={g.name} />
          <MultiplayerChip game={g} />
          <button className="icon-btn sm ghost ws-share" aria-label="Share with group" title="Share with group" onClick={() => setSharing(true)}>
            <Icon name="users" size={17} />
          </button>
        </div>
        <ShareWithGroupModal gameId={id} gameName={g.name} open={sharing} onClose={() => setSharing(false)} />
        <PreviewCard game={g} versions={versions.data?.versions ?? []} version={version} onVersion={selectVersion} building={!!activeGen} />
      </aside>

      <section className="ws-center">
        <div className="chat" ref={chatRef} onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        }}>
          {gens.error ? <ErrorNote error={gens.error} onRetry={gens.refetch} />
            : !gens.data ? <div className="chat-skeleton"><div className="skeleton skel-bubble" /><div className="skeleton skel-card" /></div>
            : ordered.length === 0 ? (
              <Empty title="Let's build something" body="Describe your game below. Attach images to set the art style." />
            ) : ordered.map((gen, i) => (
              <BuildEntry key={gen.id} generation={gen} defaultOpen={i === ordered.length - 1}
                stream={activeGen?.id === gen.id ? stream : undefined} onSelectVersion={selectVersion} />
            ))}
        </div>
        <div className="chat-composer">
          <Composer
            placeholder={g.latestVersion ? 'What should change? e.g. “add a dash move and make the slimes bounce”' : 'Describe your game…'}
            chips={g.latestVersion ? CHIPS : []}
            disabled={!!activeGen}
            disabledNote={<><Sparkle size={10} className="blue" /> Next prompt unlocks when this build finishes</>}
            onSend={async (prompt, files) => {
              setComposerError(null);
              try {
                const imageIds = await Promise.all(files.map(async (f) => (await api.upload(f)).upload.id));
                const { generation } = await api.generate(id, { prompt, imageIds });
                onStarted(generation);
              } catch (e) {
                if (activeGenerationIdFrom(e)) refreshAll();
                setComposerError(errorMessage(e));
                throw e;
              }
            }}>
            {composerError && <p className="form-error">{composerError}</p>}
          </Composer>
        </div>
      </section>

      <aside className="ws-right">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'sprites', label: <><Icon name="grid" size={15} /> Sprites</> },
          { value: 'versions', label: <><Icon name="history" size={15} /> Versions</> },
          { value: 'leaderboard', label: <><Icon name="trophy" size={15} /> Leaderboard</> },
        ]} />
        {tab === 'leaderboard' ? (
          <LeaderboardPanel gameId={id} />
        ) : tab === 'sprites' ? (
          <AssetsPanel gameId={id} version={version} pixelated={pixelated} activeGen={activeGen} stream={stream} edits={edits}
            expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} onSent={onStarted} />
        ) : (
          <VersionsList game={g} versions={versions.data?.versions ?? []} selected={version} onSelect={selectVersion} building={!!activeGen} />
        )}
      </aside>
    </div>
  );
}

function GameName({ id, name }: { id: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  const save = async () => {
    setEditing(false);
    if (!val.trim() || val.trim() === name) return setVal(name);
    try { await api.renameGame(id, val.trim()); invalidate(`game:${id}`); invalidate('games'); } catch (e) { alert(errorMessage(e)); setVal(name); }
  };
  return editing ? (
    <input className="ws-name-input" value={val} autoFocus maxLength={80} onChange={(e) => setVal(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { setVal(name); setEditing(false); } }} />
  ) : (
    <button className="ws-name" onClick={() => setEditing(true)} title="Rename"><span>{name}</span><Icon name="edit" size={14} /></button>
  );
}
