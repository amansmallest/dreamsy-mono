import type { Metadata } from "next";
import { Workspace } from "@/components/editor/Workspace";

export const metadata: Metadata = { title: "Editor", robots: { index: false, follow: false } };

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workspace id={id} />;
}
