import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { invalidate } from '../lib/store';
import { Composer } from './Composer';
import { Modal } from './ui';

const IDEAS = ['A cozy pixel farming RPG', 'Neon platformer with a grappling hook', 'Tower defense in a candy kingdom', 'Monster-catching adventure'];

export function NewGameModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  return (
    <Modal open={open} onClose={onClose} title="New game" width={640}>
      <div className="new-game">
        <label className="field">
          <span className="label">Name</span>
          <input className="input input-lg" value={name} placeholder="Broken Swords" maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="field">
          <span className="label">First prompt</span>
          <Composer placeholder="Describe your game — genre, vibe, what the player does. Drop reference images for the art style."
            chips={IDEAS} sendLabel="Build it"
            onSend={async (prompt, files) => {
              setError(null);
              try {
                const gameName = name.trim() || prompt.split(/[.!\n]/)[0]!.slice(0, 40) || 'Untitled game';
                const imageIds = await Promise.all(files.map(async (f) => (await api.upload(f)).upload.id));
                const { game } = await api.createGame(gameName);
                await api.generate(game.id, { prompt, imageIds });
                invalidate('games');
                invalidate('quota');
                onClose();
                nav(`/games/${game.id}`);
              } catch (e) {
                setError(errorMessage(e));
                throw e;
              }
            }} />
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
