import type { ReactNode } from "react"
import { TdcLogo } from "@/components/tdc-logo"
import { cn } from "@/lib/utils"

/** Full-screen 404 / error state: glow, illustration, short copy, actions. */
export function ErrorScreen({
  tone = "brand",
  illustration,
  code,
  title,
  body,
  actions,
  digest,
}: {
  tone?: "brand" | "danger"
  illustration: ReactNode
  code?: string
  title: string
  body: string
  actions: ReactNode
  digest?: string
}) {
  const glow = tone === "danger" ? "error-glow-danger" : undefined
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--color-bg-base)] p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div aria-hidden className={cn("auth-glow-a", glow)} />
      <div aria-hidden className="auth-glow-b" />

      <div className="relative z-10 flex w-full max-w-md flex-col items-center text-center">
        <TdcLogo className="auth-mark h-6" />
        <div className="error-reveal mt-8 w-full max-w-xs">{illustration}</div>
        <div className="attendee-stagger mt-6 flex flex-col items-center">
          {code ? (
            <p
              className={cn(
                "mb-3 font-mono text-xs font-bold tracking-[0.3em] uppercase",
                tone === "danger"
                  ? "text-[var(--color-bg-danger)]"
                  : "text-[var(--color-fg-brand)]",
              )}
            >
              {code}
            </p>
          ) : null}
          <h1 className="text-4xl">{title}</h1>
          {/* Colour alpha, not opacity — the stagger animation ends at opacity 1. */}
          <p className="mt-3 max-w-sm text-base text-[var(--color-fg-base)]/70">{body}</p>
          <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">{actions}</div>
          {digest ? (
            <p className="mt-6 font-mono text-xs text-[var(--color-fg-base)]/40 select-all">
              Feilkode: {digest}
            </p>
          ) : null}
        </div>
      </div>
    </main>
  )
}
