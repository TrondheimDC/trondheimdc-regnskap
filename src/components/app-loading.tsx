import { TdcRegnskapLogo } from "@/components/tdc-regnskap-logo"

export function AppLoading({ label = "Laster…" }: { label?: string }) {
  return (
    <main
      className="app-loading flex min-h-dvh flex-col items-center justify-center bg-[var(--color-bg-base)]"
      aria-busy="true"
      aria-live="polite"
    >
      <TdcRegnskapLogo className="app-loading-logo size-24 text-[var(--color-fg-brand)]" />
      <p className="app-loading-label mt-8 font-display text-sm tracking-wide text-[var(--color-fg-brand)]">
        {label}
      </p>
    </main>
  )
}
