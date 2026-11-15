import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage, insufficientCoins } from '../lib/api';
import { coins, coinsToUsd, usd } from '../lib/format';
import { invalidate } from '../lib/store';
import { Composer } from './Composer';
import { createLabel, InsufficientCoinsModal, useCreatePrice, type CoinShortfall } from './Costs';
import { Modal } from './ui';

export const IDEAS = ['A cozy pixel farming RPG', 'Neon platformer with a grappling hook', 'Tower defense in a candy kingdom', 'Monster-catching adventure'];

export function NewGameModal({ open, onClose, initialPrompt = '' }: { open: boolean; onClose: () => void; initialPrompt?: string }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [broke, setBroke] = useState<CoinShortfall | null>(null);
  // A 402 leaves the (empty) game behind; reuse it on retry instead of piling up drafts.
  const created = useRef<string | null>(null);
  const price = useCreatePrice();
  const nav = useNavigate();
  return (
    <>
    <Modal open={open} onClose={onClose} title="New game" width={640}>
      <div className="new-game">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input input-lg" value={name} placeholder="Broken Swords" maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus={!initialPrompt} />
        </label>
        <div className="field">
          <span className="field-label">First prompt</span>
          <Composer placeholder="Genre, vibe, what the player does. Drop images for the art style."
            initialText={initialPrompt} autoFocus={!!initialPrompt}
            chips={initialPrompt ? [] : IDEAS} sendLabel={createLabel(price)}
            onSend={async (prompt, files) => {
              setError(null);
              try {
                const gameName = name.trim() || prompt.split(/[.!\n]/)[0]!.slice(0, 40) || 'Untitled game';
                const imageIds = await Promise.all(files.map(async (f) => (await api.upload(f)).upload.id));
                const gameId = created.current ?? (created.current = (await api.createGame(gameName)).game.id);
                await api.generate(gameId, { prompt, imageIds });
                created.current = null;
                invalidate('games');
                invalidate('quota');
                invalidate('wallet');
                onClose();
                nav(`/games/${gameId}`);
              } catch (e) {
                const need = insufficientCoins(e);
                if (need) setBroke({ ...need, price: need.price ?? price, action: 'Creating a game' });
                else setError(errorMessage(e));
                throw e;
              }
            }} />
        </div>
        {error && <p className="form-error">{error}</p>}
        {price != null && <p className="muted new-game-cost">The first build costs {coins(price)} ({usd(coinsToUsd(price))}). Edits after that are free.</p>}
      </div>
    </Modal>
    <InsufficientCoinsModal need={broke} onClose={() => setBroke(null)} />
    </>
  );
}
