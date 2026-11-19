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
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = (games ?? []).filter((g) => !q || g.name.toLowerCase().includes(q) || g.id.includes(q));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const load = () =>
      api
        .games()
        .then((r) => {
          setGames(r.games);
          if (r.bannersPending && tries++ < 60) timer = setTimeout(load, 3000);
        })
        .catch((e) => setError((e as Error).message));
    void load();
    api.keys().then(setKeys).catch(() => {});
    return () => clearTimeout(timer);
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

      {games && games.length > 0 && (
        <div className="games-tools">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${games.length} games`} aria-label="Search games" />
          {q && <span className="muted">{shown.length} found</span>}
        </div>
      )}

      {games === null ? (
        <p className="muted">Loading…</p>
      ) : games.length === 0 ? (
        <p className="muted">No games yet. Name one above to get started.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No games match “{query}”.</p>
      ) : (
        <ul className="games-list">
          {shown.map((g) => (
            <li key={g.id}>
              <Link href={`/editor/${g.id}`} className="game-tile">
                <div className="tile-shot">
                  {g.hasThumb ? (
                    <div className="tile-cover">
                      <img className="tile-blur" src={`/api/games/${g.id}/thumb?t=${g.updated}`} alt="" aria-hidden />
                      <img className="tile-shot-img" src={`/api/games/${g.id}/thumb?t=${g.updated}`} alt={`${g.name} screenshot`} />
                    </div>
                  ) : g.banner ? (
                    <div className="tile-banner">
                      <img src={`/api/games/${g.id}/file?path=${encodeURIComponent(g.banner)}`} alt="" />
                      <span>{g.name}</span>
                    </div>
                  ) : (
                    <span className="tile-empty">{g.empty ? "not built yet" : g.name}</span>
                  )}
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
