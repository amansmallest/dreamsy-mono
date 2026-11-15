import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { coins, coinsToUsd, compactCoins, usd } from '../lib/format';
import { useResource } from '../lib/store';
import { Icon } from './Icon';
import { Button, Modal } from './ui';

export const CREATE_PRICE = 100_000;
export const REMIX_PRICE = 25_000;

/**
 * Coins a game's first build costs, or null when the API has no coins economy (wallet 404 / old API),
 * in which case callers show no price at all.
 */
export function useCreatePrice(): number | null {
  const wallet = useResource('wallet', api.wallet);
  const quota = useResource('quota', api.quota);
  if (!wallet.data) return null;
  return quota.data?.quota.createPrice ?? quota.data?.createPrice ?? wallet.data.wallet.createPrice ?? wallet.data.createPrice ?? CREATE_PRICE;
}

/** "Create · 100K coins" (or plain "Create" without an economy). */
export const createLabel = (price: number | null, base = 'Create') => (price ? `${base} · ${compactCoins(price)} coins` : base);

/** "Remix · 25K → creator"; free on your own game. */
export const remixLabel = (price: number | null | undefined, own: boolean) =>
  own || !price ? 'Remix' : `Remix · ${compactCoins(price)} → creator`;

export type CoinShortfall = { balance: number | null; price: number | null; action: string };

/** 402 insufficient_coins: what it costs, what you have, where to top up. */
export function InsufficientCoinsModal({ need, onClose }: { need: CoinShortfall | null; onClose: () => void }) {
  const price = need?.price ?? null;
  const balance = need?.balance ?? null;
  const nav = useNavigate();
  const short = price != null && balance != null ? Math.max(0, price - balance) : null;
  return (
    <Modal open={!!need} onClose={onClose} title="Not enough coins" width={440}>
      <div className="coins-modal">
        <div className="coins-modal-icon"><Icon name="coin" size={26} /></div>
        <p className="coins-modal-lede">
          {need?.action ?? 'This'} costs <b>{price != null ? coins(price) : 'more coins'}</b>
          {price != null && <span className="muted"> ({usd(coinsToUsd(price))})</span>}.
        </p>
        <dl className="coins-modal-rows">
          {balance != null && <div><dt>Your balance</dt><dd>{coins(balance)}</dd></div>}
          {short != null && short > 0 && <div><dt>You need</dt><dd>{coins(short)} more</dd></div>}
        </dl>
        <p className="muted coins-modal-note">Edits to games you've already built stay free. Earn coins when people play your published games.</p>
        <div className="coins-modal-actions">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button icon="coin" onClick={() => { onClose(); nav('/account'); }}>See wallet</Button>
        </div>
      </div>
    </Modal>
  );
}
