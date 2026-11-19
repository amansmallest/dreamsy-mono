import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { LibraryGrid } from "@/components/LibraryGrid";
import { SiteNav } from "@/components/SiteNav";
import { GAMES } from "@/lib/content";

export const metadata: Metadata = {
  title: "Library",
  description: "Games made with Dreamsy, all running on the same engine.",
  alternates: { canonical: "/library" },
  openGraph: { url: "/library", title: "Library · Dreamsy", description: "Games made with Dreamsy, all running on the same engine." },
};

export default function Library() {
  return (
    <>
      <div className="page-top">
        <SiteNav />
        <header className="page-head">
          <span className="kicker">the library</span>
          <h1>Games made with Dreamsy</h1>
          <p>{GAMES.length} games running on the Dreamsy engine. Screenshots are real frames.</p>
        </header>
      </div>
      <main className="page">
        <LibraryGrid />
      </main>
      <Footer />
    </>
  );
}
