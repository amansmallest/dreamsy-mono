"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function PlayActions({ slug, remix }: { slug: string; remix: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetch(`/api/library/${slug}/play`, { method: "POST" }).catch(() => undefined);
  }, [slug]);

  return (
    <div className="play-actions">
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
      >
        {copied ? "Link copied!" : "Share link"}
      </button>
      <a className="btn btn-light btn-sm" href={`/api/library/${slug}/download`}>Download .dpk</a>
      <button
        type="button"
        className="btn btn-light btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const res = await fetch(`/api/library/${slug}/import`, { method: "POST" });
            const body = (await res.json()) as { id?: string; error?: string };
            if (!res.ok || !body.id) throw new Error(body.error ?? "Couldn't copy this game");
            router.push(`/editor/${body.id}`);
          } catch (e) {
            alert((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? "Copying…" : remix ? "Remix in editor" : "Open a copy"}
      </button>
    </div>
  );
}
