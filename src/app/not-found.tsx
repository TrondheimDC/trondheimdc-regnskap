import type { Metadata } from "next"
import { NotFoundScreen } from "@/components/not-found-screen"

export const metadata: Metadata = { title: "Fant ikke siden" }

export default function NotFound() {
  return <NotFoundScreen />
}
