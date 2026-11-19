"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { GameSummary, KeyStatus } from "@/lib/editor-types";
import { ago, api, hasBuildKey } from "./api";
import { KeysDialog } from "./KeysDialog";

export function GamesHome() {
  const router = useRouter();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  useEffect(() => {
    api.games().then((r) => setGames(r.games)).catch((e) => setError((e as Error).message));
    api.keys().then(setKeys).catch(() => {});
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { id } = await api.create(name || "Untitled game");
      router.push(`/editor/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  return (
    <main className="games-home">
      <div className="games-head">
        <div>
          <h1>Your games</h1>
          <p>Saved on this computer. Open one to keep building, or start something new.</p>
        </div>
        <button type="button" className="btn btn-light btn-sm" onClick={() => setKeysOpen(true)}>API keys</button>
      </div>

      {keys && !hasBuildKey(keys) && (
        <div className="notice">
          <div>
            <strong>Add an API key to start building.</strong>
            <span>Dreamsy runs on your own Anthropic or OpenAI key.</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setKeysOpen(true)}>Add key</button>
        </div>
      )}

      <form className="new-game" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your new game" aria-label="New game name" maxLength={80} />
        <button type="submit" className="btn" disabled={creating}>{creating ? "Creating…" : "New game"}</button>
      </form>
      {error && <p className="form-error">{error}</p>}

      {games === null ? (
        <p className="muted">Loading…</p>
      ) : games.length === 0 ? (
        <p className="muted">No games yet. Name one above to get started.</p>
      ) : (
        <ul className="games-list">
          {games.map((g) => (
            <li key={g.id}>
              <Link href={`/editor/${g.id}`} className="game-tile">
                <div className="tile-shot">
                  {g.hasThumb ? <img src={`/api/games/${g.id}/thumb?t=${g.updated}`} alt="" /> : <span>{g.empty ? "not built yet" : g.name.slice(0, 1)}</span>}
                </div>
                <div className="tile-body">
                  <strong>{g.name}</strong>
                  <span>
                    {ago(g.updated)}
                    {g.builds ? ` · ${g.builds} ${g.builds === 1 ? "build" : "builds"}` : ""}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <KeysDialog open={keysOpen} onClose={() => setKeysOpen(false)} onChange={setKeys} />
    </main>
  );
}
