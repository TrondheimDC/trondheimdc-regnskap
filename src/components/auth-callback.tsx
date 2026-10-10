"use client"

import { KeyRound } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { AppLoading } from "@/components/app-loading"
import { ErrorScreen } from "@/components/error-screen"
import { Button } from "@/components/ui/button"
import { completeLogin } from "@/lib/fiken-browser-auth"

/** Fiken redirects here after login; swaps the code for a token, then goes back where login started. */
export function AuthCallback() {
  const router = useRouter()
  const [error, setError] = useState<string>()
  const started = useRef(false)

  useEffect(() => {
    // The code can only be exchanged once; guard against StrictMode's double effect.
    if (started.current) return
    started.current = true
    completeLogin(new URLSearchParams(window.location.search))
      // A full load: /bilag/<id> is not a prerendered route the router can fetch.
      .then((returnTo) => window.location.replace(returnTo))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [router])

  if (!error) return <AppLoading label="Logger inn…" />

  return (
    <ErrorScreen
      tone="danger"
      illustration={
        <KeyRound className="mx-auto size-20 text-[var(--color-bg-danger)]" aria-hidden />
      }
      code="Innlogging"
      title="Kom ikke inn"
      body={error}
      actions={
        <Button onClick={() => router.replace("/")} className="w-full sm:w-auto">
          Prøv igjen
        </Button>
      }
    />
  )
}
