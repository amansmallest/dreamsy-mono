import Link from "next/link";
import { GITHUB } from "@/lib/content";
import { Logo } from "./Logo";

export function SiteNav() {
  return (
    <header className="nav">
      <Link href="/" aria-label="Dreamsy home" className="nav-home">
        <Logo />
      </Link>
      <nav className="links">
        <Link href="/#how">How it works</Link>
        <Link href="/library">Library</Link>
        <Link href="/kits">Kits</Link>
        <Link href="/docs">Docs</Link>
        <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
      </nav>
      <Link className="btn btn-sm" href="/editor">Open editor</Link>
    </header>
  );
}
