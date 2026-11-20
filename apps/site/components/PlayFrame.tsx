"use client";

import { useEffect, useRef, useState } from "react";

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

/** iPhone Safari has no element full screen, so it gets a fill-the-window mode instead. */
export function PlayFrame({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [native, setNative] = useState(false);
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    const d = document as FsDocument;
    const sync = () => setNative(!!(d.fullscreenElement ?? d.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFilled(false);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("play-filled", filled);
    return () => document.documentElement.classList.remove("play-filled");
  }, [filled]);

  const on = native || filled;

  async function toggle() {
    const d = document as FsDocument;
    if (native) {
      await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    } else if (filled) {
      setFilled(false);
    } else {
      const el = box.current as FsElement | null;
      try {
        if (el?.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
        else if (el?.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else setFilled(true);
      } catch {
        setFilled(true);
      }
    }
    frame.current?.focus();  // keys go to the game, not the button
  }

  return (
    <div ref={box} className={`play-frame${filled ? " filled" : ""}`}>
      <iframe ref={frame} src={src} title={title} allow="autoplay; fullscreen; gamepad" allowFullScreen />
      <button type="button" className="play-fs" onClick={() => void toggle()} aria-label={on ? "Exit full screen" : "Full screen"}>
        {on ? (
          <svg viewBox="0 0 16 16" aria-hidden><path d="M6 1v5H1M10 1v5h5M6 15v-5H1M10 15v-5h5" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden><path d="M1 6V1h5M15 6V1h-5M1 10v5h5M15 10v5h-5" /></svg>
        )}
        <span>{on ? "Exit" : "Full screen"}</span>
      </button>
    </div>
  );
}
