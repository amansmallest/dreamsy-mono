import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { SiteNav } from "@/components/SiteNav";
import { KITS } from "@/lib/content";

export const metadata: Metadata = {
  title: "Kits",
  description: "Tested Luau libraries for common game genres.",
  alternates: { canonical: "/kits" },
  openGraph: { url: "/kits", title: "Kits · Dreamsy", description: "Tested Luau libraries for common game genres." },
};

export default function Kits() {
  const genre = KITS.filter((k) => k.group === "genre");
  const base = KITS.filter((k) => k.group === "foundation");
  return (
    <>
      <div className="page-top">
        <SiteNav />
        <header className="page-head">
          <span className="kicker">kits</span>
          <h1>Kits</h1>
          <p>Tested Luau libraries for common genres. A game opts in with one line, and the basics already work.</p>
        </header>
      </div>
      <main className="page">
        <h2 className="subhead">Genres</h2>
        <ul className="kit-grid">
          {genre.map((k, i) => (
            <li key={k.id}>
              <Link className={`kit kit-${["sky", "mist", "ice"][i % 3]}`} href={`/kits/${k.id}`}>
                <strong>{k.id}</strong>
                <span>{k.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
        <h2 className="subhead">Foundations</h2>
        <p className="subnote">Shared building blocks the genre kits use. They switch on automatically when a kit needs them.</p>
        <ul className="kit-grid">
          {base.map((k) => (
            <li key={k.id}>
              <Link className="kit kit-base" href={`/kits/${k.id}`}>
                <strong>{k.id}</strong>
                <span>{k.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </>
  );
}
