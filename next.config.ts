import type { NextConfig } from "next"

// Static export (SPA) in production, served by nginx. api.fiken.no has no CORS, so nginx proxies
// /api/fiken/* to it (docs/deploy.md), and serves index.html for paths without a file, like
// /bilag/<id>. In dev, Next does the same with rewrites.
const isDev = process.env.NODE_ENV === "development"

// The login needs it, and it is baked into the static build.
if (!isDev && !process.env.NEXT_PUBLIC_FIKEN_CLIENT_ID)
  throw new Error("NEXT_PUBLIC_FIKEN_CLIENT_ID mangler: sett den i .env.local eller i CI")

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  ...(isDev
    ? {
        async rewrites() {
          return {
            beforeFiles: [
              { source: "/api/fiken/:path*", destination: "https://api.fiken.no/api/v2/:path*" },
            ],
            afterFiles: [],
            fallback: [{ source: "/:path*", destination: "/" }],
          }
        },
      }
    : { output: "export" }),
  images: { unoptimized: true },
}

export default nextConfig
