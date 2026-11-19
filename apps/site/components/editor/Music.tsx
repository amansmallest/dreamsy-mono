"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChipPlayer, compile, parseSfx, parseSong, type Song } from "@/lib/audio";
import type { GameDetail } from "@/lib/editor-types";

const MUSIC = /^data\/music\/([a-z0-9_]+)\.json$/;
const SFX = /^data\/sfx\/([a-z0-9_]+)\.json$/;
const human = (id: string) => id.replace(/_/g, " ");
const COLORS = ["#1a7ff0", "#5fb4ff", "#0f5ccc", "#9fd1f6"];

interface Track {
  id: string;
  song?: Song;
  error?: string;
}

export function Music({ id, game, stamp, running, onAsk }: { id: string; game: GameDetail | null; stamp: number; running: boolean; onAsk: (text: string) => void }) {
  const files = game?.files ?? [];
  const musicIds = useMemo(() => files.map((f) => MUSIC.exec(f.path)?.[1]).filter((x): x is string => !!x), [files]);
  const sfxIds = useMemo(() => files.map((f) => SFX.exec(f.path)?.[1]).filter((x): x is string => !!x), [files]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const player = useRef<ChipPlayer | null>(null);
  const url = (p: string) => `/api/games/${id}/file?path=${encodeURIComponent(p)}&t=${stamp}`;

  useEffect(() => {
    player.current = new ChipPlayer();
    return () => player.current?.dispose();
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all(
      musicIds.map(async (m): Promise<Track> => {
        try {
          return { id: m, song: parseSong(await (await fetch(url(`data/music/${m}.json`))).text()) };
        } catch (e) {
          return { id: m, error: (e as Error).message };
        }
      }),
    ).then((t) => live && setTracks(t));
    return () => {
      live = false;
    };
  }, [musicIds.join(","), stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (t: Track) => {
    if (!t.song || !player.current) return;
    if (playing === t.id) {
      player.current.stop();
      setPlaying(null);
      return;
    }
    player.current.play(t.song, () => setPlaying(null));
    setPlaying(t.id);
  };

  const playSfx = async (s: string) => {
    try {
      player.current?.playSfx(parseSfx(await (await fetch(url(`data/sfx/${s}.json`))).text()));
    } catch {}
  };

  if (!musicIds.length && !sfxIds.length) {
    return (
      <div className="pad">
        <p className="muted">No music or sound effects yet.</p>
        <button type="button" className="tool" disabled={running} onClick={() => onAsk("Compose music for this game: a title theme, the main level, a boss theme and victory and game over jingles.")}>Compose music</button>
      </div>
    );
  }

  return (
    <div className="music">
      <ul className="tracks">
        {tracks.map((t) => {
          const c = t.song ? compile(t.song) : null;
          return (
            <li key={t.id} className={playing === t.id ? "on" : ""}>
              <div className="track-top">
                <button type="button" className="play" aria-label={playing === t.id ? `Stop ${t.id}` : `Play ${t.id}`} onClick={() => toggle(t)} disabled={!t.song}>
                  {playing === t.id ? "■" : "▶"}
                </button>
                <div className="track-name">
                  <strong>{human(t.id)}</strong>
                  <span className="muted">
                    {t.song && c ? `${t.song.bpm} bpm · ${Math.round(c.seconds)}s · ${t.song.loop ? "loops" : "plays once"} · ${t.song.channels.map((ch) => ch.wave).join(" ")}` : t.error}
                  </span>
                </div>
              </div>
              {t.song && <Roll song={t.song} player={playing === t.id ? player.current : null} />}
              <button type="button" className="link small" disabled={running} onClick={() => onAsk(`Change the ${human(t.id)} music (${t.id}): `)}>ask to change</button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="tool" disabled={running} onClick={() => onAsk("Compose new music: ")}>+ Compose more music</button>
      {sfxIds.length > 0 && (
        <>
          <h4 className="mini">Sound effects</h4>
          <div className="sfx-list">
            {sfxIds.map((s) => (
              <button key={s} type="button" onClick={() => void playSfx(s)}>▶ {human(s)}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Roll({ song, player }: { song: Song; player: ChipPlayer | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const compiled = useMemo(() => compile(song), [song]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const W = 280, H = 56;
    cv.width = W * 2;
    cv.height = H * 2;
    const g = cv.getContext("2d")!;
    g.scale(2, 2);
    const pitched = compiled.events.filter((e) => song.channels[e.ch]!.wave !== "noise");
    const lo = Math.min(...pitched.map((e) => Math.log2(e.freq)), 7);
    const hi = Math.max(...pitched.map((e) => Math.log2(e.freq)), 9);
    let raf = 0;
    const draw = () => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#e8f4fe";
      g.fillRect(0, 0, W, H);
      const sx = W / Math.max(1, compiled.totalSteps);
      for (const e of compiled.events) {
        const ch = song.channels[e.ch]!;
        g.fillStyle = COLORS[e.ch % COLORS.length]!;
        if (ch.wave === "noise") {
          g.globalAlpha = 0.5;
          g.fillRect(e.step * sx, H - 4, Math.max(1, sx * 0.8), 3);
        } else {
          g.globalAlpha = 0.95;
          const y = H - 6 - ((Math.log2(e.freq) - lo) / Math.max(0.5, hi - lo)) * (H - 12);
          g.fillRect(e.step * sx, y, Math.max(1, e.len * sx - 0.5), 2);
        }
      }
      g.globalAlpha = 1;
      const pos = player?.position;
      if (pos != null) {
        g.fillStyle = "#0f5ccc";
        g.fillRect(pos * W, 0, 1.5, H);
        raf = requestAnimationFrame(draw);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [compiled, song, player]);

  return <canvas ref={canvas} className="roll" aria-hidden />;
}
