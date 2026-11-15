import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import type { Game } from '../lib/api';
import { deepLink, shareLink } from '../lib/env';
import { Icon, Sparkle } from './Icon';
import { Modal } from './ui';

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <span className="label">{label}</span>
      <div className="copy-field">
        <code>{value}</code>
        <button className="icon-btn sm" aria-label={`Copy ${label}`} onClick={async () => {
          try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
        }}><Icon name={copied ? 'check' : 'copy'} size={15} /></button>
      </div>
    </div>
  );
}

export function PlayOnPhone({ game, open, onClose }: { game: Game; open: boolean; onClose: () => void }) {
  const link = deepLink(game.id);
  return (
    <Modal open={open} onClose={onClose} title={<>Play on your phone</>} width={600}>
      <div className="phone-modal">
        <div className="qr-card">
          <Sparkle size={16} className="qr-spark a" />
          <Sparkle size={11} filled={false} className="qr-spark b" />
          <QRCodeSVG value={link} size={196} bgColor="transparent" fgColor="currentColor" level="M" marginSize={0} />
        </div>
        <div className="phone-modal-copy">
          <p className="lead">Scan with your phone camera to open <b>{game.name}</b> in the Dreamsy app.</p>
          <p className="muted small">Games play on mobile — the studio is for building. Edits you make here hot-reload on the phone.</p>
          <CopyRow label="App link" value={link} />
          {game.status === 'published'
            ? <CopyRow label="Public share link" value={shareLink(game.id)} />
            : <p className="muted small"><Icon name="link" size={13} /> Publish to get a public share link.</p>}
        </div>
      </div>
    </Modal>
  );
}
