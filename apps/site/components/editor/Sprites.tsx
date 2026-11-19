"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GameDetail } from "@/lib/editor-types";
import { api } from "./api";

const IMAGE = /^assets\/[^/]+\.(svg|png|jpe?g|webp|gif)$/i;
const idOf = (path: string) => path.slice("assets/".length).replace(/\.[a-z]+$/i, "");

export function Sprites({ id, game, stamp, running, onAsk, onSaved }: { id: string; game: GameDetail | null; stamp: number; running: boolean; onAsk: (text: string) => void; onSaved: () => void }) {
  const sprites = useMemo(() => (game?.files ?? []).filter((f) => IMAGE.test(f.path)), [game]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const url = (p: string) => `/api/games/${id}/file?path=${encodeURIComponent(p)}&t=${stamp}`;

  useEffect(() => {
    if (selected && !sprites.some((s) => s.path === selected)) setSelected(null);
  }, [sprites, selected]);

  if (!sprites.length) return <p className="muted pad">Sprites show up here after the first build.</p>;

  return (
    <div className="sprites">
      {selected && (
        <div className="sprite-focus">
          <div className="sprite-stage">
            <img src={url(selected)} alt={idOf(selected)} />
          </div>
          <div className="sprite-meta">
            <strong>{idOf(selected)}</strong>
            <code>asset:{idOf(selected)}</code>
          </div>
          <div className="sprite-actions">
            {selected.endsWith(".svg") && (
              <button type="button" className="tool" disabled={running} onClick={() => setEditing(selected)}>Edit SVG</button>
            )}
            <button type="button" className="tool" disabled={running} onClick={() => onAsk(`Redraw the ${idOf(selected)} sprite: `)}>Ask to redraw</button>
          </div>
        </div>
      )}
      <ul className="sprite-grid">
        {sprites.map((s) => (
          <li key={s.path}>
            <button type="button" className={selected === s.path ? "on" : ""} onClick={() => setSelected(s.path)} title={idOf(s.path)}>
              <img src={url(s.path)} alt="" loading="lazy" />
              <span>{idOf(s.path)}</span>
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <SvgEditor
          id={id}
          path={editing}
          source={url(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function SvgEditor({ id, path, source, onClose, onSaved }: { id: string; path: string; source: string; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    fetch(source)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setError("Couldn't load this sprite."));
  }, [source]);

  const preview = useMemo(() => (text ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` : ""), [text]);

  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} onCancel={onClose}>
      <div className="dialog-head">
        <h2>Edit {idOf(path)}</h2>
        <button type="button" className="icon-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="svg-editor">
        <textarea value={text ?? "Loading…"} spellCheck={false} onChange={(e) => setText(e.target.value)} aria-label="SVG source" />
        <div className="svg-preview">{preview && <img src={preview} alt="Preview" />}</div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-foot">
        <span className="muted">Saving makes a new version you can restore.</span>
        <button type="button" className="btn btn-light btn-sm" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !text}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.saveFile(id, path, text!);
              onSaved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save sprite"}
        </button>
      </div>
    </dialog>
  );
}
