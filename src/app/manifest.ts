import type { MetadataRoute } from "next"

// Metadata route: prerendered to out/manifest.webmanifest by the static export.
export const dynamic = "force-static"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TDC Regnskap",
    short_name: "Regnskap",
    description: "Fører Checkin-regnskapsbilaget i Fiken.",
    lang: "nb",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0f0f0f",
    theme_color: "#0f0f0f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }
}
