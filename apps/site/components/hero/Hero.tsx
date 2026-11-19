"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { GITHUB, MCP_COMMAND } from "@/lib/content";
import { CopyCommand } from "../CopyCommand";
import { SiteNav } from "../SiteNav";
import { startHero } from "./engine";

export function Hero() {
  const hero = useRef<HTMLElement>(null);
  const sky = useRef<HTMLCanvasElement>(null);
  const device = useRef<HTMLCanvasElement>(null);
  const prompt = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const steps = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return startHero(
      { hero: hero.current!, sky: sky.current!, device: device.current!, prompt: prompt.current!, status: status.current!, steps: steps.current! },
      reduced,
    );
  }, []);

  return (
    <section className="hero" ref={hero}>
      <canvas className="sky" ref={sky} aria-hidden />
      <SiteNav />

      <div className="hero-grid">
        <div className="copy">
          <p className="eyebrow">
            <span className="led" aria-hidden /> Open source · 2D &amp; 2.5D · iOS, Android &amp; web
          </p>
          <h1 className="display">
            <span className="line">Describe a game.</span>
            <span className="line">
              Then <span className="hl">play it.</span>
            </span>
          </h1>
          <div className="ctas">
            <Link className="btn" href="/docs">Get started</Link>
            <a className="btn btn-light" href={GITHUB} target="_blank" rel="noreferrer">View on GitHub</a>
          </div>
          <CopyCommand command={MCP_COMMAND} />
        </div>

        <div className="stage">
          <canvas
            className="device"
            ref={device}
            role="img"
            aria-label="A little handheld that turns ideas into games. Click it for another idea."
            title="Click for another idea"
          />
          <div className="window prompt-window">
            <div className="titlebar">
              <span className="close" aria-hidden />
              <span className="title">idea.txt</span>
            </div>
            <div className="window-body">
              <span className="status" ref={status} data-state="listening">listening</span>
              <p className="prompt-text">
                <span className="gt">&gt;</span> <span ref={prompt} />
                <span className="caret" aria-hidden />
              </p>
              <ol className="steps" ref={steps} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
