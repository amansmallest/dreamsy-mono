"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyStatus, Provider } from "@/lib/editor-types";
import { api } from "./api";

const ROWS: { id: Provider; name: string; use: string; placeholder: string }[] = [
  { id: "anthropic", name: "Anthropic", use: "Builds games. Recommended.", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", use: "Builds games, or backs up Anthropic.", placeholder: "sk-…" },
  { id: "gemini", name: "Google Gemini", use: "Optional. Paints images for sprites and backgrounds.", placeholder: "AIza…" },
];

export function KeysDialog({ open, onClose, onChange }: { open: boolean; onClose: () => void; onChange: (k: KeyStatus) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<Provider, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Provider | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      api.keys().then(setStatus).catch(() => {});
    } else if (!open && d.open) d.close();
  }, [open]);

  const apply = (k: KeyStatus) => {
    setStatus(k);
    onChange(k);
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <div className="dialog-head">
        <h2>API keys</h2>
        <button type="button" className="icon-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <p className="dialog-note">
        Builds run on your own key. Keys are kept in a secure cookie on this device that page scripts can&apos;t read. The
        editor server reads it only to start your build and never saves it to disk.
      </p>
      <ul className="key-list">
        {ROWS.map((r) => {
          const saved = status?.[r.id];
          return (
            <li key={r.id}>
              <div className="key-top">
                <strong>{r.name}</strong>
                <span className={saved ? "pill on" : "pill"}>{saved ? `saved ${saved}` : "not set"}</span>
              </div>
              <p>{r.use}</p>
              {saved ? (
                <button
                  type="button"
                  className="btn btn-light btn-sm"
                  disabled={busy === r.id}
                  onClick={async () => {
                    setBusy(r.id);
                    try {
                      apply(await api.removeKey(r.id));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Remove
                </button>
              ) : (
                <form
                  className="key-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setError(null);
                    setBusy(r.id);
                    try {
                      apply(await api.saveKey(r.id, drafts[r.id] ?? ""));
                      setDrafts((d) => ({ ...d, [r.id]: "" }));
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={r.placeholder}
                    aria-label={`${r.name} key`}
                    value={drafts[r.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                  />
                  <button type="submit" className="btn btn-sm" disabled={busy === r.id || !drafts[r.id]?.trim()}>Save</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </dialog>
  );
}
