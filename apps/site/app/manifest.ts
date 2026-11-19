import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dreamsy",
    short_name: "Dreamsy",
    description: SITE_DESCRIPTION,
    id: "/",
    start_url: "/editor",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f8fcff",
    theme_color: "#1a7ff0",
    categories: ["games", "developer", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Editor", url: "/editor" },
      { name: "Library", url: "/library" },
      { name: "Docs", url: "/docs" },
    ],
  };
}
