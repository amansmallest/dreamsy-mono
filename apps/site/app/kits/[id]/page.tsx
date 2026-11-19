import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer } from "@/components/Footer";
import { GameCard } from "@/components/GameCard";
import { Inline } from "@/components/Md";
import { SiteNav } from "@/components/SiteNav";
import { Window } from "@/components/Window";
import { GITHUB, KITS } from "@/lib/content";
import { loadKit, type Block } from "@/lib/kits";

export const dynamicParams = false;

export function generateStaticParams() {
  return KITS.map((k) => ({ id: k.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const kit = KITS.find((k) => k.id === id);
  const title = `${id} kit`;
  const description = kit ? `The ${id} kit for Dreamsy: ${kit.blurb}.` : undefined;
  return { title, description, alternates: { canonical: `/kits/${id}` }, openGraph: { url: `/kits/${id}`, title: `${title} · Dreamsy`, description } };
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}><Inline text={b.text} /></p>
        ) : b.kind === "ul" ? (
          <ul key={i}>{b.items.map((t, j) => <li key={j}><Inline text={t} /></li>)}</ul>
        ) : (
          <pre key={i} className="code"><code>{b.code}</code></pre>
        ),
      )}
    </>
  );
}

const chip = (id: string) => (
  <Link key={id} className="chip" href={`/kits/${id}`}>{id}</Link>
);

export default async function KitDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!KITS.some((k) => k.id === id)) notFound();
  const kit = loadKit(id);
  return (
    <>
      <div className="page-top">
        <SiteNav />
        <header className="page-head">
          <Link className="back" href="/kits">← all kits</Link>
          <span className="kicker">{kit.group === "foundation" ? "foundation kit" : "genre kit"}</span>
          <h1>{kit.id}</h1>
          <p>{kit.blurb}</p>
        </header>
      </div>
      <main className="page kit-page">
        <article className="doc">
          <Blocks blocks={kit.intro} />
          {kit.setup.length > 0 && (
            <>
              <h2>Setup</h2>
              <Blocks blocks={kit.setup} />
            </>
          )}
          {kit.example && (
            <>
              <h2>Example game</h2>
              <div className="kit-example">
                <GameCard game={kit.example} />
              </div>
            </>
          )}
          <p>
            <a className="btn btn-light" href={`${GITHUB}/blob/main/kits/${kit.id}/KIT.md`} target="_blank" rel="noreferrer">
              Full reference on GitHub
            </a>
          </p>
        </article>
        <aside className="kit-side">
          <Window title="kit.json" tone="sky">
            <dl className="facts">
              <dt>Use it</dt>
              <dd><code>kits = [&quot;{kit.id}&quot;]</code></dd>
              <dt>Builds on</dt>
              <dd className="chips">{kit.requires.length ? kit.requires.map(chip) : <span className="muted">nothing</span>}</dd>
              {kit.usedBy.length > 0 && (
                <>
                  <dt>Used by</dt>
                  <dd className="chips">{kit.usedBy.map(chip)}</dd>
                </>
              )}
            </dl>
          </Window>
          <Window title="modules" tone="mist">
            <ul className="mods">
              {kit.modules.map((m) => (
                <li key={m}><code>{m === "init" ? `@kit/${kit.id}` : `@kit/${kit.id}/${m}`}</code></li>
              ))}
            </ul>
          </Window>
          {kit.schemas.length > 0 && (
            <Window title="content schemas" tone="ice">
              <ul className="mods">
                {kit.schemas.map((s) => (
                  <li key={s}><code>{s}.json</code></li>
                ))}
              </ul>
            </Window>
          )}
          {kit.sections.length > 0 && (
            <Window title="reference">
              <ul className="mods plain">
                {kit.sections.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Window>
          )}
        </aside>
      </main>
      <Footer />
    </>
  );
}
