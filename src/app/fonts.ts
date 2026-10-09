import { IBM_Plex_Sans, Space_Grotesk, Space_Mono } from "next/font/google"

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-plex",
})

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-grotesk",
})

const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
})

/** Font variables for `<html>` — shared by the root layout and `global-error`. */
export const fontVariables = `${plex.variable} ${grotesk.variable} ${mono.variable}`
