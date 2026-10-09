import type { NextConfig } from "next"

// Static export (SPA) in production, served by nginx. api.fiken.no has no CORS, so nginx proxies
// /api/fiken/* to it (docs/deploy.md). In dev, Next does the same with a rewrite.
const isDev = process.env.NODE_ENV === "development"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  ...(isDev
    ? {
        async rewrites() {
          return [{ source: "/api/fiken/:path*", destination: "https://api.fiken.no/api/v2/:path*" }]
        },
      }
    : { output: "export" }),
  images: { unoptimized: true },
}

export default nextConfig
