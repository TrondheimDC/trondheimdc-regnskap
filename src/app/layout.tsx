import type { Metadata, Viewport } from "next"
import { fontVariables } from "./fonts"
import { Providers } from "./providers"
import "./globals.css"

export const metadata: Metadata = {
  applicationName: "TDC Regnskap",
  title: {
    default: "TDC Regnskap",
    template: "%s · TDC Regnskap",
  },
  description: "Fører Checkin-regnskapsbilaget i Fiken.",
  authors: [{ name: "TDC" }],
  creator: "TDC",
  appleWebApp: {
    capable: true,
    title: "TDC Regnskap",
    statusBarStyle: "black-translucent",
  },
  // Internal tool — keep it out of search results.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f0f0f",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nb" className={fontVariables}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
