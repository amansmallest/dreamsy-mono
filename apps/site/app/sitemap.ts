import type { MetadataRoute } from "next";
import { KITS } from "@/lib/content";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (path: string, priority: number) => ({ url: `${SITE_URL}${path}`, lastModified: now, changeFrequency: "weekly" as const, priority });
  return [
    page("/", 1),
    page("/library", 0.8),
    page("/kits", 0.8),
    page("/docs", 0.8),
    page("/editor", 0.6),
    ...KITS.map((k) => page(`/kits/${k.id}`, 0.5)),
  ];
}
