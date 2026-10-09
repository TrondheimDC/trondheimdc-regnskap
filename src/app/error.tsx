"use client"

import Link from "next/link"
import { useEffect } from "react"
import { ErrorScreen } from "@/components/error-screen"
import { TAccountErrorIllustration } from "@/components/illustrations"
import { Button } from "@/components/ui/button"

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  // Static export: everything renders in the browser, so re-rendering is the whole retry.
  // (`retry()` would also refetch the prebuilt RSC payload, which cannot have changed.)
  return (
    <>
      <title>Noe gikk galt · TDC Regnskap</title>
      <ErrorScreen
        tone="danger"
        illustration={<TAccountErrorIllustration />}
        code="Feil"
        title="Noe gikk galt"
        body="Prøv igjen. Var du midt i en føring, sjekk i Fiken hva som kom med før du fører på nytt."
        digest={error.digest}
        actions={
          <>
            <Button onClick={reset}>Prøv igjen</Button>
            <Button asChild variant="surface">
              <Link href="/">Til start</Link>
            </Button>
          </>
        }
      />
    </>
  )
}
