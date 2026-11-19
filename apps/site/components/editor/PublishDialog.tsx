"use client";

import { useEffect, useRef, useState } from "react";
import { api, type CloudStatus } from "./api";

const STORE = "dreamsy.publisher.v1";

export function PublishDialog({ id, name, open, onClose, onChange }: { id: string; name: string; open: boolean; onClose: () => void; onChange: (s: CloudStatus) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [author, setAuthor] = useState("");
  const [link, setLink] = useState("");
  const [email, setEmail] = useState("");
  const [remix, setRemix] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setError(null);
      try {
        const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}") as { author?: string; link?: string; email?: string };
        setAuthor(saved.author ?? "");
        setLink(saved.link ?? "");
        setEmail(saved.email ?? "");
      } catch {}
      api
        .cloudStatus(id)
        .then((s) => {
          setStatus(s);
          if (s.publication) {
            setAuthor(s.publication.author);
            setLink(s.publication.link);
            setEmail(s.publication.email);
            setRemix(!!s.publication.remix);
          }
        })
        .catch((e) => setError((e as Error).message));
    } else if (!open && d.open) d.close();
  }, [open, id]);

  const pub = status?.publication;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem(STORE, JSON.stringify({ author, link, email }));
      } catch {}
      const r = await api.publish(id, { author, link, email, remix });
      setStatus(r.status);
      onChange(r.status);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <div className="dialog-head">
        <h2>{pub ? "Published" : "Publish to the library"}</h2>
        <button type="button" className="icon-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <p className="dialog-note">
        {pub
          ? `“${name}” is in the Dreamsy library (version ${pub.version}${pub.plays ? `, ${pub.plays} plays` : ""}). Publishing again updates it to the latest version.`
          : `Share “${name}” in the Dreamsy library so anyone can find it, download it and play it. Your name and link are public; your email is not.`}
      </p>
      <form className="publish-form" onSubmit={submit}>
        <label className="field">
          <span>Creator name (public)</span>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={40} placeholder="anonymous dreamer" />
        </label>
        <label className="field">
          <span>Link (public, optional)</span>
          <input value={link} onChange={(e) => setLink(e.target.value)} maxLength={200} placeholder="https://your-site.com" type="url" />
        </label>
        <label className="field">
          <span>Email (private, optional)</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} placeholder="only used to reach you about this game" type="email" />
        </label>
        <label className="check">
          <input type="checkbox" checked={remix} onChange={(e) => setRemix(e.target.checked)} />
          <span>Let others remix it (remixes credit you)</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-foot">
          {pub && (
            <button
              type="button"
              className="btn btn-light btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const s = await api.unpublish(id);
                  setStatus(s);
                  onChange(s);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Unpublish
            </button>
          )}
          <span className="spacer" />
          <button type="submit" className="btn btn-sm" disabled={busy}>{busy ? "Publishing…" : pub ? "Update" : "Publish"}</button>
        </div>
      </form>
    </dialog>
  );
}
