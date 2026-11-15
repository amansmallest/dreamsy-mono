import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAuthedImage } from '../lib/blobs';
import { Icon, Sparkle, type IconName } from './Icon';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'solid' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  sparkles?: boolean;
  busy?: boolean;
};

export function Button({ variant = 'solid', size = 'md', icon, sparkles, busy, children, className = '', disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${busy ? 'is-busy' : ''} ${className}`} disabled={disabled || busy} {...rest}>
      {sparkles && <Sparkle size={size === 'lg' ? 14 : 11} className="btn-spark" />}
      {busy ? <Spinner /> : icon && <Icon name={icon} size={size === 'sm' ? 15 : 18} />}
      {children && <span>{children}</span>}
      {sparkles && <Sparkle size={size === 'lg' ? 14 : 11} className="btn-spark" />}
    </button>
  );
}

export function IconButton({ icon, label, className = '', active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean }) {
  return (
    <button className={`icon-btn ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={18} />
    </button>
  );
}

export const Spinner = ({ size = 16 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

export function Chip({ children, tone = 'plain', icon }: { children: ReactNode; tone?: 'plain' | 'ink' | 'ok' | 'danger' | 'live'; icon?: IconName }) {
  return (
    <span className={`chip chip-${tone}`}>
      {tone === 'live' && <span className="live-dot" />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/** Outlined pill progress bar with ink fill; `value` null = indeterminate. */
export function ProgressPill({ value, size = 'md' }: { value: number | null; size?: 'sm' | 'md' }) {
  return (
    <div className={`progress progress-${size} ${value == null ? 'is-indeterminate' : ''}`} role="progressbar"
      aria-valuenow={value == null ? undefined : Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={value == null ? undefined : { width: `${Math.max(4, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function AuthedImg({ url, alt, className = '', pixelated, fallback }: { url: string | null | undefined; alt: string; className?: string; pixelated?: boolean; fallback?: ReactNode }) {
  const { src, failed } = useAuthedImage(url);
  if (!url || failed) return <>{fallback ?? null}</>;
  if (!src) return <div className={`img-loading ${className}`} />;
  return <img src={src} alt={alt} className={`${className} ${pixelated ? 'pixelated' : ''}`} draggable={false} />;
}

export function Modal({ open, onClose, children, title, width = 520 }: { open: boolean; onClose: () => void; children: ReactNode; title?: ReactNode; width?: number }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal>
        <div className="modal-head">
          {title && <h2 className="modal-title">{title}</h2>}
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEscape(open, onClose);
  return createPortal(
    <div className={`drawer-wrap ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal>{open && children}</aside>
    </div>,
    document.body,
  );
}

function useEscape(open: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && cb.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
}

export function Empty({ title, body, action, art = 'sparkles' }: { title: string; body?: ReactNode; action?: ReactNode; art?: 'sparkles' | 'box' }) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden>
        {art === 'sparkles' ? (
          <>
            <Sparkle size={44} />
            <Sparkle size={18} filled={false} className="empty-s2" />
            <Sparkle size={12} className="empty-s3" />
          </>
        ) : <Icon name="grid" size={40} />}
      </div>
      <h3 className="empty-title">{title}</h3>
      {body && <p className="empty-body">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-note">
      <Icon name="alert" size={18} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
