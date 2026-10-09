"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Building2,
  Check,
  ChevronRight,
  FileText,
  Inbox,
  LogIn,
  LogOut,
  RefreshCw,
  Upload,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { ReviewScreen, type Selection } from "@/components/review-screen"
import { TdcLogo } from "@/components/tdc-logo"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { API_BASE, config } from "@/lib/app-config"
import { listReportDocuments, type ReportDocument, resolveCompany } from "@/lib/booking"
import { Fiken } from "@/lib/fiken"
import { browserAuth, isLoggedIn, logout, startLogin } from "@/lib/fiken-browser-auth"
import { formatDay, formatMonth } from "@/lib/format"
import { cn } from "@/lib/utils"

export function Home() {
  // Providers only render this after mount, so sessionStorage is readable here.
  const [loggedIn, setLoggedIn] = useState(isLoggedIn)
  const queryClient = useQueryClient()

  if (!loggedIn) return <LoginScreen />
  return (
    <Workspace
      onLogout={() => {
        logout()
        queryClient.clear()
        setLoggedIn(false)
      }}
    />
  )
}

function LoginScreen() {
  const login = useMutation({ mutationFn: startLogin })
  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-[var(--color-bg-base)] p-6">
      <div aria-hidden className="auth-glow-a" />
      <div aria-hidden className="auth-glow-b" />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-8">
        <div className="auth-mark flex flex-col items-center gap-3 text-center">
          <TdcLogo className="h-9" />
          <div>
            <p className="text-xs font-medium tracking-[0.2em] text-[var(--color-fg-base)]/50 uppercase">
              TDC
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg-base)]/90">
              Regnskap
            </h1>
          </div>
        </div>

        <div className="auth-card flex w-full flex-col gap-5 rounded-2xl p-6">
          <p className="text-[var(--color-fg-base)]/70">
            Fører månedens regnskapsbilag fra Checkin i Fiken. Ingenting føres før du har sett over
            tallene og bekreftet.
          </p>
          {login.error ? (
            <Alert variant="destructive">
              <AlertDescription>{login.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <Button onClick={() => login.mutate()} disabled={login.isPending} className="w-full">
            <LogIn className="size-5" aria-hidden />
            {login.isPending ? "Sender deg til Fiken…" : "Logg inn med Fiken"}
          </Button>
        </div>
      </div>
    </main>
  )
}

/** Page frame: logo, title, content. Same shape as the innsjekk screens, wider for the card grid. */
function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="attendee-reveal mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6 lg:px-8">
      <header className="shrink-0 pt-2">
        <TdcLogo />
        <h1 className="mt-2 text-4xl">{title}</h1>
      </header>
      {children}
    </main>
  )
}

function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <p className="text-sm tracking-wide text-[var(--color-fg-brand)]">{children}</p>
      {aside}
    </div>
  )
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const [selection, setSelection] = useState<Selection>()

  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const anonymous = new Fiken(browserAuth, "", API_BASE)
      const user = await anonymous.me()
      const company = await resolveCompany(anonymous, config.companySlug)
      return { user, company, client: new Fiken(browserAuth, company.slug, API_BASE) }
    },
  })

  if (session.isError) {
    return (
      <Screen title="Regnskap">
        <Alert variant="destructive">
          <AlertTitle>Fikk ikke kontakt med Fiken</AlertTitle>
          <AlertDescription>{session.error.message}</AlertDescription>
        </Alert>
        <Button variant="surface" onClick={onLogout} className="sm:self-start">
          <LogIn className="size-5" aria-hidden />
          Logg inn på nytt
        </Button>
      </Screen>
    )
  }

  if (selection && session.data) {
    return (
      <ReviewScreen
        client={session.data.client}
        companyName={session.data.company.name}
        selection={selection}
        onBack={() => setSelection(undefined)}
      />
    )
  }

  return (
    <Screen title="Regnskap">
      <div className="flex shrink-0 items-center gap-3 rounded-xl bg-[var(--color-bg-surface)] px-4 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]">
          <Building2 className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {session.data ? (
            <>
              <p className="text-sm opacity-60">{session.data.user.name}</p>
              <p className="truncate font-display text-xl">{session.data.company.name}</p>
            </>
          ) : (
            <>
              <p className="text-sm opacity-60">Kobler til Fiken…</p>
              <p aria-hidden className="font-display text-xl">
                &nbsp;
              </p>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Logg ut"
          onClick={onLogout}
          className="text-[var(--color-fg-base)]/70 hover:text-[var(--color-bg-danger)]"
        >
          <LogOut className="size-4" aria-hidden />
        </Button>
      </div>

      <Picker client={session.data?.client} onPick={setSelection} />
    </Screen>
  )
}

/** Same footprint as the cards, so the grid doesn't jump when the inbox arrives. */
function PickerLoading() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-[9.5rem] items-center justify-center gap-3 rounded-xl bg-[var(--color-bg-surface)]/50 text-sm text-[var(--color-fg-base)]/60 sm:col-span-2 lg:col-span-3"
    >
      <Spinner />
      Henter regnskapsbilag fra Fiken…
    </div>
  )
}

function Picker({ client, onPick }: { client?: Fiken; onPick: (s: Selection) => void }) {
  const inbox = useQuery({
    queryKey: ["inbox", client?.companySlug],
    queryFn: () =>
      client
        ? listReportDocuments(client, config.inbox.reportName)
        : Promise.reject(new Error("Ikke koblet til Fiken")),
    enabled: client !== undefined,
  })
  const docs = inbox.data ?? []
  const unused = docs.filter((d) => !d.used).length

  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionLabel
          aside={
            inbox.data ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => inbox.refetch()}
                disabled={inbox.isFetching}
                className="text-[var(--color-fg-base)]/70"
              >
                <RefreshCw
                  className={cn("size-3.5", inbox.isFetching && "animate-spin")}
                  aria-hidden
                />
                Oppdater
              </Button>
            ) : null
          }
        >
          Regnskapsbilag i Fiken-innboksen
        </SectionLabel>

        {inbox.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Fikk ikke lest innboksen</AlertTitle>
            <AlertDescription>{inbox.error.message}</AlertDescription>
          </Alert>
        ) : null}

        {inbox.data && docs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl bg-[var(--color-bg-surface)] px-6 py-10 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]">
              <Inbox className="size-7" aria-hidden />
            </span>
            <h2 className="text-2xl">Ingen regnskapsbilag</h2>
            <p className="max-w-xs text-sm text-[var(--color-fg-base)]/70">
              Checkin sender regnskapsbilaget for forrige måned til innboksen i starten av hver
              måned.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => inbox.refetch()}
              disabled={inbox.isFetching}
            >
              <RefreshCw className="size-4" aria-hidden />
              Sjekk igjen
            </Button>
          </div>
        ) : null}

        {inbox.data && docs.length > 0 && unused === 0 ? (
          <p className="text-sm text-[var(--color-fg-base)]/60">
            Ingen nye bilag – alle er brukt i Fiken. Neste kommer i starten av måneden. Åpne et
            brukt bilag for å kontrollere føringen.
          </p>
        ) : null}

        {inbox.isError || (inbox.data && docs.length === 0) ? null : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {inbox.data ? (
              docs.map((doc) => (
                <li key={doc.documentId} className="flex">
                  <ReportCard doc={doc} onPick={() => onPick({ kind: "inbox", doc })} />
                </li>
              ))
            ) : (
              <li className="contents">
                <PickerLoading />
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Kontroller en PDF</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Button
            asChild
            variant="surface"
            className="flex h-auto w-full items-start justify-start gap-3 px-4 py-4 text-left text-base whitespace-normal"
          >
            <label>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/5">
                <Upload className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 font-normal">
                <span className="block font-semibold">Velg fil</span>
                <span className="mt-1 block text-sm opacity-70">
                  Viser tallene og kontrollene. For å føre må bilaget ligge i Fiken-innboksen.
                </span>
              </span>
              <input
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ""
                  if (file) onPick({ kind: "file", file })
                }}
              />
            </label>
          </Button>
        </div>
      </div>
    </>
  )
}

function ReportCard({ doc, onPick }: { doc: ReportDocument; onPick: () => void }) {
  return (
    <Button
      variant="surface"
      onClick={onPick}
      className="flex h-auto w-full flex-col items-stretch justify-start gap-3 p-4 text-left text-base whitespace-normal"
    >
      <span className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            doc.used
              ? "bg-white/5 text-[var(--color-fg-base)]/60"
              : "bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]",
          )}
        >
          <FileText className="size-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col font-normal">
          <span
            className={cn(
              "font-display text-2xl leading-tight",
              doc.used && "text-[var(--color-fg-base)]/80",
            )}
          >
            {doc.month ? formatMonth(doc.month) : doc.name}
          </span>
          <span className="mt-0.5 truncate text-sm opacity-60">
            {doc.month ? doc.name : doc.filename}
          </span>
        </span>
        {doc.used ? (
          <Badge variant="outline" className="text-[var(--color-fg-base)]/70">
            <Check aria-hidden />
            Brukt
          </Badge>
        ) : (
          <Badge>Ny</Badge>
        )}
      </span>
      <span className="flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-sm font-normal">
        <span className="opacity-60">Mottatt {formatDay(doc.createdAt)}</span>
        <span className="flex items-center gap-1 opacity-60">
          {doc.used ? "Kontroller" : null}
          <ChevronRight className="size-5 shrink-0" aria-hidden />
        </span>
      </span>
    </Button>
  )
}
