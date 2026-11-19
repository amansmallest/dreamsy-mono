import type { Metadata } from "next";
import { GamesHome } from "@/components/editor/GamesHome";
import { SiteNav } from "@/components/SiteNav";

export const metadata: Metadata = {
  title: "Editor",
  description: "Make and edit games with Dreamsy on your own AI key.",
  alternates: { canonical: "/editor" },
  openGraph: { url: "/editor", title: "Editor · Dreamsy", description: "Make and edit games with Dreamsy on your own AI key." },
};

export default function EditorPage() {
  return (
    <div className="editor-page">
      <SiteNav />
      <GamesHome />
    </div>
  );
}
