import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Button, isMac, Kbd } from './ui';

export type Attachment = { file: File; url: string };

const MAX_IMAGES = 8;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic'];

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  useEffect(() => () => items.forEach((a) => URL.revokeObjectURL(a.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    items,
    add(files: FileList | File[]) {
      const ok = [...files].filter((f) => TYPES.includes(f.type) && f.size <= 10 * 1024 * 1024);
      setItems((p) => [...p, ...ok.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_IMAGES));
    },
    remove(i: number) { setItems((p) => p.filter((_, j) => j !== i)); },
    clear() { setItems([]); },
  };
}

export function Composer({ placeholder, chips = [], disabled, disabledNote, onSend, autoFocus, children, sendLabel = 'Build', initialText = '' }: {
  placeholder: string;
  initialText?: string;
  chips?: string[];
  disabled?: boolean;
  disabledNote?: ReactNode;
  autoFocus?: boolean;
  sendLabel?: string;
  /** Throw to keep the text. */
  onSend: (prompt: string, files: File[]) => Promise<void>;
  children?: ReactNode;
}) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const att = useAttachments();
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(260, el.scrollHeight)}px`;
  }, [text]);

  const canSend = !!text.trim() && !busy && !disabled;
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await onSend(text.trim(), att.items.map((a) => a.file));
      setText('');
      att.clear();
    } catch { /* caller showed the error */ } finally { setBusy(false); }
  };

  return (
    <div className={`composer ${drag ? 'is-drag' : ''} ${disabled ? 'is-disabled' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); att.add(e.dataTransfer.files); }}>
      {children}
      {att.items.length > 0 && (
        <div className="composer-attach">
          {att.items.map((a, i) => (
            <div key={a.url} className="attach-thumb">
              <img src={a.url} alt={a.file.name} />
              <button aria-label="Remove image" onClick={() => att.remove(i)}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <textarea ref={ta} value={text} autoFocus={autoFocus} rows={2} placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => e.clipboardData.files.length && att.add(e.clipboardData.files)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      {chips.length > 0 && (
        <div className="quick-chips">
          {chips.map((c) => (
            <button key={c} className="quick-chip" onClick={() => { setText((t) => (t.trim() ? `${t.trim()} ${c.toLowerCase()}` : c)); ta.current?.focus(); }}>{c}</button>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <input ref={fileInput} type="file" accept={TYPES.join(',')} multiple hidden onChange={(e) => { if (e.target.files) att.add(e.target.files); e.target.value = ''; }} />
        <button className="icon-btn ghost" aria-label="Attach reference images" title="Attach reference images" onClick={() => fileInput.current?.click()}>
          <Icon name="image" />
        </button>
        <span className="composer-hint">{disabled && disabledNote ? disabledNote : <><Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd><Kbd>↵</Kbd> to send</>}</span>
        <Button icon="arrowUp" busy={busy} disabled={!canSend} onClick={send}>{sendLabel}</Button>
      </div>
    </div>
  );
}
