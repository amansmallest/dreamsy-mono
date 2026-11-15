import { useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { BuildRing } from '../../components/GameCard';
import { AuthedImg, Button, Drawer, Empty, ErrorNote, IconButton, ProgressPill, Segmented } from '../../components/ui';
import { activeGenerationIdFrom, api, ApiError, errorMessage, isActive, type Asset, type Generation } from '../../lib/api';
import { assetCategory, bytes, humanId, type AssetCategory } from '../../lib/format';
import { humanizePhase, type Stream } from '../../lib/generation';
import { useResource } from '../../lib/store';
import { latestLine } from '../../lib/timeline';

export type Edit = { before: number; after: number };

const isImage = (a: Asset) => /\.(png|svg|jpe?g|webp|gif)$/i.test(a.file) || a.kind === 'image' || a.kind === 'sprite';
const CATS: { value: 'all' | AssetCategory; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'characters', label: 'Characters' }, { value: 'tiles', label: 'Tiles' },
  { value: 'ui', label: 'UI' }, { value: 'other', label: 'Other' },
];

/** Live-edit state for a sprite, if the active build is scoped to it. */
function editingState(id: string, gen: Generation | null, stream: Stream | null) {
  if (!gen || !isActive(gen.status) || !(gen.assetIds ?? []).includes(id)) return null;
  return { line: stream ? latestLine(stream.events) : null, phase: stream?.eta?.phase ?? null };
}

function SpriteImage({ gameId, asset, version, pixelated, className }: { gameId: string; asset: Asset; version: number; pixelated: boolean; className?: string }) {
  // Before/after: look the same id up in another version's listing (shared cache).
  const other = useResource(version ? `assets:${gameId}:${version}` : null, () => api.assets(gameId, version));
  const url = version ? other.data?.assets.find((a) => a.id === asset.id)?.url ?? null : asset.url;
  return <AuthedImg url={url} alt={asset.id} className={className} pixelated={pixelated}
    fallback={<span className="sprite-missing">{other.data ? 'not in this version' : ''}</span>} />;
}

function SpriteCard({ gameId, asset, pixelated, selected, edit, live, onOpen, onToggle }: {
  gameId: string; asset: Asset; pixelated: boolean; selected: boolean; edit?: Edit;
  live: ReturnType<typeof editingState>; onOpen: () => void; onToggle: () => void;
}) {
  const [showBefore, setShowBefore] = useState(false);
  return (
    <div className={`sprite-card ${selected ? 'is-selected' : ''} ${live ? 'is-live' : ''}`}>
      <button className="sprite-hit" onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? onToggle() : onOpen())} aria-label={`Edit ${asset.id}`}>
        <div className="sprite-tile">
          {showBefore && edit
            ? <SpriteImage gameId={gameId} asset={asset} version={edit.before} pixelated={pixelated} className="sprite-img" />
            : <AuthedImg url={asset.url} alt={asset.id} className="sprite-img" pixelated={pixelated} />}
          {live && <div className="sprite-live"><BuildRing size={34} /></div>}
        </div>
        <span className="sprite-name">{humanId(asset.id)}</span>
      </button>
      <button className={`sprite-check ${selected ? 'is-on' : ''}`} aria-label={selected ? 'Deselect' : 'Select'} onClick={onToggle}>
        {selected && <Icon name="check" size={12} />}
      </button>
      {edit && !live && (
        <button className={`sprite-ba ${showBefore ? 'is-before' : ''}`} onClick={() => setShowBefore(!showBefore)} title="Toggle before/after">
          {showBefore ? `Before · v${edit.before}` : `After · v${edit.after}`}
        </button>
      )}
      {live && (
        <div className="sprite-progress">
          <ProgressPill size="sm" value={null} />
          <span className="tiny">{live.line ?? (live.phase ? humanizePhase(live.phase) : 'Redrawing…')}</span>
        </div>
      )}
    </div>
  );
}

export function AssetsPanel({ gameId, version, pixelated, activeGen, stream, edits, expanded, onToggleExpand, onSent }: {
  gameId: string; version: number; pixelated: boolean;
  activeGen: Generation | null; stream: Stream | null; edits: Record<string, Edit>;
  expanded: boolean; onToggleExpand: () => void;
  onSent: (g: Generation) => void;
}) {
  const res = useResource(version ? `assets:${gameId}:${version}` : null, () => api.assets(gameId, version));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'all' | AssetCategory>('all');
  const [sel, setSel] = useState<string[]>([]);
  const [editing, setEditing] = useState<string[] | null>(null);

  const images = useMemo(() => (res.data?.assets ?? []).filter(isImage), [res.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: images.length };
    for (const a of images) c[assetCategory(a.id)] = (c[assetCategory(a.id)] ?? 0) + 1;
    return c;
  }, [images]);
  const shown = images.filter((a) => (cat === 'all' || assetCategory(a.id) === cat) && (!q || a.id.toLowerCase().includes(q.toLowerCase().replace(/\s+/g, '_'))));
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const editingAssets = editing ? images.filter((a) => editing.includes(a.id)) : [];

  if (!version) return <Empty title="No sprites yet" body="Sprites show up here after the first build lands." />;
  return (
    <div className="assets">
      <div className="assets-tools">
        <div className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search sprites" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <IconButton icon={expanded ? 'minimize' : 'maximize'} label={expanded ? 'Collapse gallery' : 'Expand gallery'} onClick={onToggleExpand} />
      </div>
      <div className="assets-cats">
        <Segmented value={cat} onChange={setCat} options={CATS.filter((c) => c.value === 'all' || counts[c.value]).map((c) => ({
          value: c.value, label: <>{c.label}<span className="seg-count">{counts[c.value] ?? 0}</span></>,
        }))} />
      </div>
      {res.error ? (
        res.error instanceof ApiError && res.error.status === 404
          ? <Empty title="Sprite listing unavailable" body="This API build doesn't list assets yet." />
          : <ErrorNote error={res.error} onRetry={res.refetch} />
      ) : !res.data ? (
        <div className="sprite-grid">{Array.from({ length: 9 }, (_, i) => <div key={i} className="sprite-card skeleton" />)}</div>
      ) : shown.length === 0 ? (
        <Empty title={images.length ? 'No matches' : 'No image assets in this version'} body={images.length ? 'Try another filter.' : 'Ask for art in the chat and it will appear here.'} />
      ) : (
        <div className="sprite-grid">
          {shown.map((a) => (
            <SpriteCard key={a.id} gameId={gameId} asset={a} pixelated={pixelated} selected={sel.includes(a.id)} edit={edits[a.id]}
              live={editingState(a.id, activeGen, stream)} onOpen={() => setEditing([a.id])} onToggle={() => toggle(a.id)} />
          ))}
        </div>
      )}
      {sel.length > 0 && (
        <div className="select-bar">
          <span><b>{sel.length}</b> selected</span>
          <button className="link-btn" onClick={() => setSel([])}>Clear</button>
          <Button size="sm" onClick={() => setEditing(sel)}>Edit together</Button>
        </div>
      )}
      <Drawer open={!!editing} onClose={() => setEditing(null)}>
        {editing && (
          <SpriteEditor gameId={gameId} assets={editingAssets} pixelated={pixelated} activeGen={activeGen} stream={stream}
            onClose={() => setEditing(null)} onSent={(g) => { setSel([]); onSent(g); }} edits={edits} />
        )}
      </Drawer>
    </div>
  );
}

const CHIPS = ['Recolor', 'Bigger silhouette', 'Add outline', 'Make it cuter', 'More detail', 'Match the palette'];

function SpriteEditor({ gameId, assets, pixelated, activeGen, stream, onClose, onSent, edits }: {
  gameId: string; assets: Asset[]; pixelated: boolean; activeGen: Generation | null; stream: Stream | null;
  onClose: () => void; onSent: (g: Generation) => void; edits: Record<string, Edit>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const one = assets.length === 1 ? assets[0]! : null;
  const live = assets.some((a) => editingState(a.id, activeGen, stream));
  const blocked = !!activeGen && isActive(activeGen.status);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const names = assets.map((a) => a.id).join(', ');
      const { generation } = await api.generate(gameId, { prompt: `Edit sprite${assets.length > 1 ? 's' : ''} ${names}: ${text.trim()}`, assetIds: assets.map((a) => a.id) });
      setText('');
      onSent(generation);
    } catch (e) {
      setErr(activeGenerationIdFrom(e) ? 'A build is already running on this game — wait for it to finish.' : errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <div>
          <span className="kicker">{assets.length > 1 ? `${assets.length} sprites` : 'Sprite'}</span>
          <h2 className="h2">{one ? humanId(one.id) : 'Edit together'}</h2>
        </div>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>
      {one ? (
        <div className={`editor-stage ${zoom ? 'is-zoom' : ''}`} onClick={() => setZoom(!zoom)} title="Click to zoom">
          <AuthedImg url={one.url} alt={one.id} className="editor-img" pixelated={pixelated} />
          {live && <div className="sprite-live"><BuildRing size={56} /></div>}
        </div>
      ) : (
        <div className="editor-multi">
          {assets.map((a) => (
            <div key={a.id} className="editor-multi-item">
              <div className="sprite-tile"><AuthedImg url={a.url} alt={a.id} className="sprite-img" pixelated={pixelated} /></div>
              <span className="tiny">{humanId(a.id)}</span>
            </div>
          ))}
        </div>
      )}
      {one && (
        <div className="editor-meta">
          <span className="mini-chip">{one.id}</span>
          <span className="mini-chip">{one.file.split('.').pop()?.toUpperCase()}</span>
          <span className="mini-chip">{bytes(one.sizeBytes)}</span>
          {one.model && <span className="mini-chip">{one.model}</span>}
          {edits[one.id] && <span className="mini-chip">edited · v{edits[one.id]!.before} → v{edits[one.id]!.after}</span>}
        </div>
      )}
      {one?.prompt && (
        <blockquote className="provenance">
          <span className="field-label">Drawn from</span>
          <p>{one.prompt}</p>
        </blockquote>
      )}
      {live && stream ? (
        <div className="editor-live">
          <ProgressPill value={null} />
          <span className="small">{latestLine(stream.events) ?? 'Redrawing…'}</span>
        </div>
      ) : null}
      <div className="editor-compose">
        <span className="field-label">What should change?</span>
        <textarea className="input" rows={3} value={text} placeholder={one ? `e.g. make the ${humanId(one.id)}'s shield red` : 'e.g. give them all a darker outline'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <div className="quick-chips">
          {CHIPS.map((c) => <button key={c} className="quick-chip" onClick={() => setText((t) => (t ? `${t}, ${c.toLowerCase()}` : c))}>{c}</button>)}
        </div>
        {err && <p className="form-error">{err}</p>}
        <Button size="lg" className="w-full" busy={busy} disabled={!text.trim() || blocked} onClick={send}>
          {blocked ? 'Build in progress…' : `Redraw ${assets.length > 1 ? `${assets.length} sprites` : 'sprite'}`}
        </Button>
      </div>
    </div>
  );
}
