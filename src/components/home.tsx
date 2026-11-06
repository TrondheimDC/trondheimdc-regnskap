"use client"

import {
  queryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  Building2,
  Check,
  ChevronRight,
  FileQuestion,
  FileText,
  Hotel,
  LogIn,
  LogOut,
  ReceiptText,
  RefreshCw,
  Upload,
} from "lucide-react"
import { usePathname } from "next/navigation"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { AppLoading } from "@/components/app-loading"
import { ErrorScreen } from "@/components/error-screen"
import { HotelReviewScreen, type HotelSelection } from "@/components/hotel-review-screen"
import {
  TAccountBookedIllustration,
  TAccountErrorIllustration,
  TAccountUploadIllustration,
  TAccountWaitingIllustration,
} from "@/components/illustrations"
import { NotFoundScreen } from "@/components/not-found-screen"
import { ReviewScreen, type Selection } from "@/components/review-screen"
import { TdcLogo } from "@/components/tdc-logo"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { UtleggReviewScreen, type UtleggSelection } from "@/components/utlegg-review-screen"
import { API_BASE, config } from "@/lib/app-config"
import { listReportDocuments, pickCompany, type ReportDocument } from "@/lib/booking"
import { pdfPages } from "@/lib/checkin"
import { type Company, type EhfDocument, Fiken, type InboxDocument } from "@/lib/fiken"
import { browserAuth, isLoggedIn, logout, startLogin } from "@/lib/fiken-browser-auth"
import { formatDay, formatMonth } from "@/lib/format"
import { looksLikeHotelInvoice } from "@/lib/hotel"
import { listHotelInvoices } from "@/lib/hotel-booking"
import { formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"
import { looksLikeUtleggsrapport } from "@/lib/utlegg"
import { listUtleggDocuments } from "@/lib/utlegg-booking"

/**
 * The app's screens: the inbox, a bilag from it, the hotel's invoice, an utleggsrapport, or a local
 * file. They all
 * live in this one page; nginx (and the dev rewrite in next.config.ts) serves it for every path
 * without a file.
 */
type Route =
  | { page: "inbox"; tab: Tab }
  | { page: "bilag"; documentId: string }
  | { page: "hotell"; ehfId: string }
  | { page: "utlegg"; documentId: string }
  | { page: "file" }

function parseRoute(pathname: string): Route | undefined {
  const path = pathname.replace(/\/+$/, "") || "/"
  const tab = TABS.find((t) => TAB_PATH[t] === path)
  if (tab) return { page: "inbox", tab }
  if (path === "/fil") return { page: "file" }
  const ehfId = path.match(/^\/hotell\/(\d+)$/)?.[1]
  if (ehfId) return { page: "hotell", ehfId }
  const utleggId = path.match(/^\/utlegg\/(\d+)$/)?.[1]
  if (utleggId) return { page: "utlegg", documentId: utleggId }
  const documentId = path.match(/^\/bilag\/(\d+)$/)?.[1]
  return documentId ? { page: "bilag", documentId } : undefined
}

/** The front page shows one kind of bilag at a time; each tab has its own path. */
type Tab = "utlegg" | "checkin" | "hotell" | "adhoc"

/** The configured tabs, in order. The first is the front page. */
const TABS: Tab[] = [
  ...(config.utlegg ? (["utlegg"] as const) : []),
  "checkin",
  ...(config.hotel ? (["hotell"] as const) : []),
  "adhoc",
]

const TAB_PATH: Record<Tab, string> = {
  utlegg: "/utlegg",
  checkin: "/checkin",
  hotell: "/hotell",
  adhoc: "/ad-hoc",
  ...{ [TABS[0] ?? "checkin"]: "/" },
}

/**
 * Navigation is shallow: the page stays mounted and the query cache keeps what was read from
 * Fiken. Back/forward and reload work because the route is in the URL.
 */
function navigate(path = "/") {
  window.history.pushState(null, "", path)
  window.scrollTo(0, 0)
}

export function Home() {
  // Providers only render this after mount, so sessionStorage is readable here.
  const [loggedIn, setLoggedIn] = useState(isLoggedIn)
  const queryClient = useQueryClient()
  const route = parseRoute(usePathname())

  if (!route) return <NotFoundScreen />
  if (!loggedIn) return <LoginScreen />
  return (
    <Workspace
      route={route}
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
          <h1 className="text-lg font-semibold tracking-tight text-[var(--color-fg-base)]/90">
            Regnskap
          </h1>
        </div>

        <div className="auth-card flex w-full flex-col gap-5 rounded-2xl p-6">
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

const inboxQuery = (client?: Fiken) =>
  queryOptions({
    queryKey: ["inbox", client?.companySlug],
    queryFn: () =>
      client
        ? listReportDocuments(client, config.inbox.reportName)
        : Promise.reject(new Error("Ikke koblet til Fiken")),
    enabled: client !== undefined,
  })

const hotelQuery = (client?: Fiken) =>
  queryOptions({
    queryKey: ["hotel-invoices", client?.companySlug],
    queryFn: () =>
      client && config.hotel
        ? listHotelInvoices(client, config.hotel)
        : Promise.reject(new Error("Ikke koblet til Fiken")),
    enabled: client !== undefined && config.hotel !== undefined,
  })

const utleggQuery = (client?: Fiken) =>
  queryOptions({
    queryKey: ["utlegg-docs", client?.companySlug],
    queryFn: () =>
      client && config.utlegg
        ? listUtleggDocuments(client, config.utlegg)
        : Promise.reject(new Error("Ikke koblet til Fiken")),
    enabled: client !== undefined && config.utlegg !== undefined,
  })

/** Whether a picked PDF is the hotel's invoice, an utleggsrapport or a Checkin bilag. */
const fileKindQuery = (file?: File) =>
  queryOptions({
    queryKey: ["file-kind", file?.name, file?.size, file?.lastModified],
    // Anything that isn't clearly the hotel's invoice opens as a Checkin bilag, which explains
    // what it couldn't read.
    queryFn: async () => {
      const pages = file
        ? await pdfPages(new Uint8Array(await file.arrayBuffer())).catch(() => undefined)
        : undefined
      if (pages && looksLikeHotelInvoice(pages)) return "hotel" as const
      if (pages && looksLikeUtleggsrapport(pages)) return "utlegg" as const
      return "checkin" as const
    },
    enabled: file !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  })

// The company the user chose, for users with access to several. Not a secret; survives logout.
const COMPANY_KEY = "regnskap.company"

// A picked file can't go in the URL; it waits in the query cache until reload or logout.
const FILE_KEY = ["file"]

function Workspace({ route, onLogout }: { route: Route; onLogout: () => void }) {
  const queryClient = useQueryClient()
  const docId = route.page === "bilag" ? route.documentId : undefined
  const ehfId = route.page === "hotell" ? route.ehfId : undefined
  const utleggId = route.page === "utlegg" ? route.documentId : undefined
  const fileOpen = route.page === "file"

  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const anonymous = new Fiken(browserAuth, "", API_BASE)
      const user = await anonymous.me()
      const companies = await anonymous.companies()
      return { user, companies }
    },
  })
  const [chosen, setChosen] = useState(() => localStorage.getItem(COMPANY_KEY) ?? undefined)
  const [choosing, setChoosing] = useState(false)
  const companies = session.data?.companies
  const company =
    companies && !choosing ? pickCompany(companies, [chosen, config.companySlug]) : undefined
  const client = useMemo(
    () => (company ? new Fiken(browserAuth, company.slug, API_BASE) : undefined),
    [company],
  )
  const inbox = useQuery(inboxQuery(client))
  const hotelInvoices = useQuery(hotelQuery(client))
  const utleggDocs = useQuery(utleggQuery(client))

  const choose = (c: Company) => {
    localStorage.setItem(COMPANY_KEY, c.slug)
    setChosen(c.slug)
    setChoosing(false)
  }

  const file = fileOpen ? queryClient.getQueryData<File>(FILE_KEY) : undefined
  const fileKind = useQuery(fileKindQuery(file))
  const doc = docId ? inbox.data?.find((d) => String(d.documentId) === docId) : undefined
  const ehf = ehfId ? hotelInvoices.data?.find((d) => String(d.ehfDocumentId) === ehfId) : undefined
  const hotelSelection: HotelSelection | undefined =
    file && fileKind.data === "hotel"
      ? { kind: "file", file }
      : ehf
        ? { kind: "ehf", doc: ehf }
        : undefined
  const utleggDoc = utleggId
    ? utleggDocs.data?.find((d) => String(d.documentId) === utleggId)
    : undefined
  const utleggSelection: UtleggSelection | undefined =
    file && fileKind.data === "utlegg"
      ? { kind: "file", file }
      : utleggDoc
        ? { kind: "utlegg", doc: utleggDoc }
        : undefined
  const selection: Selection | undefined =
    file && fileKind.data === "checkin"
      ? { kind: "file", file }
      : doc
        ? { kind: "inbox", doc }
        : undefined

  // After a reload the file is gone; show the inbox instead of a dead link.
  const lostFile = fileOpen && file === undefined
  useEffect(() => {
    if (lostFile) window.history.replaceState(null, "", TAB_PATH.adhoc)
  }, [lostFile])

  const open = (s: Selection | HotelSelection | UtleggSelection) => {
    if (s.kind === "inbox") return navigate(`/bilag/${s.doc.documentId}`)
    if (s.kind === "ehf") return navigate(`/hotell/${s.doc.ehfDocumentId}`)
    if (s.kind === "utlegg") return navigate(`/utlegg/${s.doc.documentId}`)
    queryClient.setQueryData(FILE_KEY, s.file)
    navigate("/fil")
  }

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

  if (companies?.length === 0) {
    return (
      <ErrorScreen
        illustration={
          <Building2 className="mx-auto size-20 text-[var(--color-fg-brand)]" aria-hidden />
        }
        title="Ingen selskaper i Fiken"
        body="Fiken-brukeren din har ikke tilgang til noen selskaper."
        actions={
          <Button onClick={onLogout} className="w-full sm:w-auto">
            <LogIn className="size-5" aria-hidden />
            Logg inn på nytt
          </Button>
        }
      />
    )
  }

  if (companies && !company) {
    return (
      <CompanyPicker
        companies={companies}
        current={chosen ?? config.companySlug}
        onPick={choose}
        onCancel={choosing ? () => setChoosing(false) : undefined}
        onLogout={onLogout}
      />
    )
  }

  if (hotelSelection && session.data && company && client) {
    return (
      <HotelReviewScreen
        client={client}
        companyName={company.name}
        selection={hotelSelection}
        onBack={() => navigate(TAB_PATH[hotelSelection.kind === "file" ? "adhoc" : "hotell"])}
      />
    )
  }

  if (utleggSelection && session.data && company && client) {
    return (
      <UtleggReviewScreen
        client={client}
        companyName={company.name}
        selection={utleggSelection}
        onBack={() => navigate(TAB_PATH[utleggSelection.kind === "file" ? "adhoc" : "utlegg"])}
      />
    )
  }

  if (file && !fileKind.data && !fileKind.isError) return <AppLoading label="Åpner bilaget…" />

  if (selection && session.data && company && client) {
    return (
      <ReviewScreen
        client={client}
        companyName={company.name}
        selection={selection}
        onBack={() => navigate(TAB_PATH[selection.kind === "file" ? "adhoc" : "checkin"])}
      />
    )
  }

  // Opened from a link or reload: wait for the list to know which invoice it is.
  if (ehfId && !hotelInvoices.isError) {
    if (!hotelInvoices.data) return <AppLoading label="Åpner fakturaen…" />
    return (
      <ErrorScreen
        illustration={
          <FileQuestion className="mx-auto size-20 text-[var(--color-fg-brand)]" aria-hidden />
        }
        title="Fant ikke fakturaen"
        body="Den ligger ikke som EHF fra hotellet i Fiken."
        actions={
          <Button onClick={() => navigate(TAB_PATH.hotell)} className="w-full sm:w-auto">
            Til hotellfakturaer
          </Button>
        }
      />
    )
  }

  // Opened from a link or reload: wait for the list to know which report it is.
  if (utleggId && !utleggDocs.isError) {
    if (!utleggDocs.data) return <AppLoading label="Åpner utleggsrapporten…" />
    return (
      <ErrorScreen
        illustration={
          <FileQuestion className="mx-auto size-20 text-[var(--color-fg-brand)]" aria-hidden />
        }
        title="Fant ikke utleggsrapporten"
        body="Den ligger ikke i innboksen i Fiken."
        actions={
          <Button onClick={() => navigate(TAB_PATH.utlegg)} className="w-full sm:w-auto">
            Til utlegg
          </Button>
        }
      />
    )
  }

  // Opened from a link or reload: wait for the inbox to know which bilag it is.
  if (docId && !inbox.isError) {
    if (!inbox.data) return <AppLoading label="Åpner bilaget…" />
    return (
      <ErrorScreen
        illustration={
          <FileQuestion className="mx-auto size-20 text-[var(--color-fg-brand)]" aria-hidden />
        }
        title="Fant ikke bilaget"
        body="Det ligger ikke i innboksen i Fiken."
        actions={
          <Button onClick={() => navigate(TAB_PATH.checkin)} className="w-full sm:w-auto">
            Til Checkin-bilag
          </Button>
        }
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
          {session.data && company ? (
            <>
              <p className="text-sm opacity-60">{session.data.user.name}</p>
              <p className="truncate font-display text-xl">{company.name}</p>
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
        {companies && companies.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
            Bytt selskap
          </Button>
        ) : null}
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

      <Picker
        tab={route.page === "inbox" ? route.tab : (TABS[0] ?? "checkin")}
        client={client}
        onPick={open}
      />
    </Screen>
  )
}

/** For users with access to several Fiken companies (and not the configured one). */
function CompanyPicker({
  companies,
  current,
  onPick,
  onCancel,
  onLogout,
}: {
  companies: Company[]
  current?: string
  onPick: (c: Company) => void
  /** Set when switching from the inbox: go back without choosing. */
  onCancel?: () => void
  onLogout: () => void
}) {
  return (
    <Screen title="Velg selskap">
      <SectionLabel>Hvilket selskap skal bilagene føres i?</SectionLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {companies.map((c) => (
          <Button
            key={c.slug}
            variant="surface"
            onClick={() => onPick(c)}
            className="h-auto items-center justify-start gap-3 whitespace-normal rounded-xl px-4 py-4 text-left"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]">
              <Building2 className="size-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-xl">{c.name}</span>
              <span className="block text-sm opacity-60">
                {c.organizationNumber ? `Org.nr. ${c.organizationNumber}` : c.slug}
              </span>
            </span>
            {c.testCompany ? <Badge variant="outline">Testselskap</Badge> : null}
            {c.slug === current ? (
              <Check className="size-5 text-[var(--color-fg-brand)]" aria-hidden />
            ) : null}
          </Button>
        ))}
      </div>
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel} className="sm:self-start">
          Avbryt
        </Button>
      ) : (
        <Button variant="ghost" onClick={onLogout} className="sm:self-start">
          <LogOut className="size-4" aria-hidden />
          Logg ut
        </Button>
      )}
    </Screen>
  )
}

// Show only what is left to book, or everything. Per viewer; not a secret.
const FILTER_KEY = "regnskap.filter"
type Filter = "open" | "all"

function readFilter(): Filter {
  try {
    return localStorage.getItem(FILTER_KEY) === "all" ? "all" : "open"
  } catch {
    return "open"
  }
}

const TAB_LABEL: Record<Tab, string> = {
  utlegg: "Utlegg",
  checkin: "Checkin",
  hotell: "Hotell",
  adhoc: "Ad hoc",
}
const TAB_ICON: Record<Tab, typeof FileText> = {
  utlegg: ReceiptText,
  checkin: FileText,
  hotell: Hotel,
  adhoc: Upload,
}

const isOpenReport = (d: ReportDocument) => !d.used
const isOpenUtlegg = (d: InboxDocument) => !d.status
const isOpenHotel = (d: EhfDocument) => d.status === "unprocessed"

/** How many are left to book, once the list is in. */
function openCount<T>(data: T[] | undefined, isOpen: (d: T) => boolean) {
  return data?.filter(isOpen).length
}

function Picker({
  tab,
  client,
  onPick,
}: {
  tab: Tab
  client?: Fiken
  onPick: (s: Selection | HotelSelection | UtleggSelection) => void
}) {
  const [filter, setFilterState] = useState(readFilter)
  const setFilter = (f: Filter) => {
    setFilterState(f)
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {}
  }

  const inbox = useQuery(inboxQuery(client))
  const utlegg = useQuery(utleggQuery(client))
  const hotel = useQuery(hotelQuery(client))
  const counts: Record<Tab, number | undefined> = {
    checkin: openCount(inbox.data, isOpenReport),
    utlegg: openCount(utlegg.data, isOpenUtlegg),
    hotell: openCount(hotel.data, isOpenHotel),
    adhoc: undefined,
  }
  const active = tab === "adhoc" ? undefined : { checkin: inbox, utlegg, hotell: hotel }[tab]
  const showAll = () => setFilter("all")
  const panelId = `panel-${tab}`

  return (
    <div className="flex flex-col gap-4">
      {TABS.length > 1 ? <Tabs current={tab} counts={counts} panelId={panelId} /> : null}

      {active ? (
        <div className="flex items-center gap-2">
          <fieldset className="flex rounded-xl bg-[var(--color-bg-surface)] p-1">
            <legend className="sr-only">Vis</legend>
            {(
              [
                ["open", "Ikke ført"],
                ["all", "Alle"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-lg",
                  filter === value
                    ? "bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)] hover:bg-[var(--color-fg-brand)]/20"
                    : "text-[var(--color-fg-base)]/70",
                )}
              >
                {label}
              </Button>
            ))}
          </fieldset>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => active.refetch()}
            disabled={active.isFetching}
            aria-label="Oppdater"
            className="text-[var(--color-fg-base)]/70"
          >
            <RefreshCw className={cn("size-4", active.isFetching && "animate-spin")} aria-hidden />
            <span className="hidden sm:inline">Oppdater</span>
          </Button>
        </div>
      ) : null}

      <div
        id={panelId}
        {...(TABS.length > 1 ? { role: "tabpanel", "aria-labelledby": `tab-${tab}` } : {})}
        className="min-h-[26rem]"
      >
        {tab === "adhoc" ? (
          <FileDrop onFile={(file) => onPick({ kind: "file", file })} />
        ) : tab === "checkin" ? (
          <DocList
            key={`checkin-${filter}`}
            query={inbox}
            filter={filter}
            isOpen={isOpenReport}
            keyOf={(d) => d.documentId}
            card={(doc) => <ReportCard doc={doc} onPick={() => onPick({ kind: "inbox", doc })} />}
            loading="Henter bilag fra innboksen…"
            error="Klarte ikke å hente innboksen"
            none={{
              title: "Ingen bilag ennå",
              body: "Checkin sender bilaget for forrige måned til innboksen i Fiken tidlig i måneden.",
            }}
            done={{
              title: "Alt er ført",
              body: "Neste bilag fra Checkin kommer tidlig i neste måned.",
            }}
            onShowAll={showAll}
          />
        ) : tab === "utlegg" ? (
          <DocList
            key={`utlegg-${filter}`}
            query={utlegg}
            filter={filter}
            isOpen={isOpenUtlegg}
            keyOf={(d) => d.documentId}
            card={(doc) => <UtleggCard doc={doc} onPick={() => onPick({ kind: "utlegg", doc })} />}
            loading="Henter utleggsrapporter fra innboksen…"
            error="Klarte ikke å hente utleggsrapporter"
            none={{
              title: "Ingen utleggsrapporter",
              body: "De kommer til innboksen i Fiken når noen sender utleggsskjemaet.",
            }}
            done={{
              title: "Alle utlegg er ført",
              body: "Nye utleggsrapporter dukker opp her når de kommer til innboksen.",
            }}
            onShowAll={showAll}
          />
        ) : (
          <DocList
            key={`hotell-${filter}`}
            query={hotel}
            filter={filter}
            isOpen={isOpenHotel}
            keyOf={(d) => d.ehfDocumentId}
            card={(doc) => <HotelCard doc={doc} onPick={() => onPick({ kind: "ehf", doc })} />}
            loading="Henter fakturaer fra Fiken…"
            error="Klarte ikke å hente EHF-fakturaer"
            none={{
              title: "Ingen hotellfaktura",
              body: "Fakturaen kommer som EHF i Fiken etter konferansen.",
            }}
            done={{
              title: "Hotellfakturaen er ført",
              body: "Det ligger ingen ubrukte EHF-er fra hotellet i Fiken.",
            }}
            onShowAll={showAll}
          />
        )}
      </div>
    </div>
  )
}

/** Ad hoc: open any PDF from disk, by picking it or dropping it here. */
function FileDrop({ onFile }: { onFile: (file: File) => void }) {
  const [over, setOver] = useState(false)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target only; "Velg PDF" is the accessible way in.
    <section
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf")
        if (file) onFile(file)
      }}
      className={cn(
        "flex min-h-[26rem] flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition-colors",
        over ? "border-[var(--color-fg-brand)] bg-[var(--color-fg-brand)]/5" : "border-white/15",
      )}
    >
      <div className="error-reveal w-full max-w-56">
        <TAccountUploadIllustration />
      </div>
      <div className="attendee-stagger mt-6 flex flex-col items-center">
        <h2 className="text-2xl">Åpne en PDF</h2>
        <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-base)]/70">
          Se tallene og kontrollene for et bilag, en utleggsrapport eller hotellfakturaen. For å
          føre den må den ligge i Fiken.
        </p>
        <div className="mt-6">
          <Button asChild variant="outline">
            <label>
              <Upload className="size-5" aria-hidden />
              Velg PDF
              <input
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ""
                  if (file) onFile(file)
                }}
              />
            </label>
          </Button>
        </div>
        <p className="mt-3 hidden text-xs text-[var(--color-fg-base)]/50 sm:block">
          eller slipp den her
        </p>
      </div>
    </section>
  )
}

/** Utlegg / Checkin / Hotell / Ad hoc; the lists show how many are left to book. */
function Tabs({
  current,
  counts,
  panelId,
}: {
  current: Tab
  counts: Record<Tab, number | undefined>
  panelId: string
}) {
  const go = (t: Tab) => {
    if (t !== current) navigate(TAB_PATH[t])
    document.getElementById(`tab-${t}`)?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label="Bilagstype"
      className="grid gap-1 rounded-2xl bg-[var(--color-bg-surface)] p-1"
      style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}
      onKeyDown={(e) => {
        const i = TABS.indexOf(current)
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
        if (!step) return
        e.preventDefault()
        go(TABS[(i + step + TABS.length) % TABS.length] ?? current)
      }}
    >
      {TABS.map((t) => {
        const Icon = TAB_ICON[t]
        const selected = t === current
        const count = counts[t]
        return (
          <Button
            key={t}
            id={`tab-${t}`}
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? panelId : undefined}
            tabIndex={selected ? 0 : -1}
            variant="ghost"
            size="sm"
            onClick={() => go(t)}
            className={cn(
              "h-14 min-w-0 flex-col gap-0.5 px-1 text-xs sm:h-11 sm:flex-row sm:gap-2 sm:px-2 sm:text-base",
              selected
                ? "bg-[var(--color-bg-base)] text-[var(--color-fg-base)] hover:bg-[var(--color-bg-base)]"
                : "text-[var(--color-fg-base)]/60",
            )}
          >
            <Icon
              className={cn("size-5 sm:size-4", selected && "text-[var(--color-fg-brand)]")}
              aria-hidden
            />
            <span className="max-w-full truncate">{TAB_LABEL[t]}</span>
            {/* Same box whether the count is in or not, so the tabs don't shift. On phones it sits
                on the icon's corner. */}
            <span className="absolute top-1 left-[calc(50%+0.375rem)] flex h-5 min-w-5 items-center justify-center sm:static">
              {count === undefined ? null : count > 0 ? (
                <span className="tabular rounded-full bg-[var(--color-fg-brand)] px-1.5 text-xs leading-5 font-semibold text-[var(--color-fg-always-dark)]">
                  {count}
                  <span className="sr-only"> ikke ført</span>
                </span>
              ) : (
                <Check className="size-4 text-[var(--color-fg-base)]/40" aria-label="Alt ført" />
              )}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

type EmptyCopy = { title: string; body: string }

/** One tab's list: loading, error, nothing received, all booked, or the cards. */
function DocList<T>({
  query,
  filter,
  isOpen,
  keyOf,
  card,
  loading,
  error,
  none,
  done,
  onShowAll,
}: {
  query: UseQueryResult<T[]>
  filter: Filter
  isOpen: (d: T) => boolean
  keyOf: (d: T) => number
  card: (d: T) => ReactNode
  loading: string
  error: string
  none: EmptyCopy
  done: EmptyCopy
  onShowAll: () => void
}) {
  if (query.isError) {
    return (
      <EmptyState
        illustration={<TAccountErrorIllustration />}
        title={error}
        body={query.error.message}
        action={
          <Button onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className="size-5" aria-hidden />
            Prøv igjen
          </Button>
        }
      />
    )
  }

  if (!query.data) {
    return (
      <div
        aria-busy="true"
        className="flex h-[26rem] items-center justify-center gap-3 rounded-2xl bg-[var(--color-bg-surface)]/50 text-sm text-[var(--color-fg-base)]/60"
      >
        <Spinner />
        {loading}
      </div>
    )
  }

  if (query.data.length === 0) {
    return (
      <EmptyState
        illustration={<TAccountWaitingIllustration />}
        title={none.title}
        body={none.body}
        action={
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={cn("size-5", query.isFetching && "animate-spin")} aria-hidden />
            Se etter nye
          </Button>
        }
      />
    )
  }

  const shown = filter === "open" ? query.data.filter(isOpen) : query.data
  if (shown.length === 0) {
    return (
      <EmptyState
        illustration={<TAccountBookedIllustration />}
        title={done.title}
        body={done.body}
        action={
          <Button variant="outline" onClick={onShowAll}>
            Vis førte ({query.data.length})
          </Button>
        }
      />
    )
  }

  return (
    <ul className="attendee-reveal grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((d) => (
        <li key={keyOf(d)} className="flex min-w-0">
          {card(d)}
        </li>
      ))}
    </ul>
  )
}

/** Empty or error state inside a tab: illustration, short heading, one action. */
function EmptyState({
  illustration,
  title,
  body,
  action,
}: {
  illustration: ReactNode
  title: string
  body: string
  action: ReactNode
}) {
  return (
    <section className="flex min-h-[26rem] flex-col items-center justify-center rounded-2xl border border-white/10 px-6 py-10 text-center">
      <div className="error-reveal w-full max-w-56">{illustration}</div>
      <div className="attendee-stagger mt-6 flex flex-col items-center">
        <h2 className="text-2xl">{title}</h2>
        <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-base)]/70">{body}</p>
        <div className="mt-6">{action}</div>
      </div>
    </section>
  )
}

function UtleggCard({ doc, onPick }: { doc: InboxDocument; onPick: () => void }) {
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
            doc.status
              ? "bg-white/5 text-[var(--color-fg-base)]/60"
              : "bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]",
          )}
        >
          <ReceiptText className="size-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col font-normal">
          <span className="font-display text-2xl leading-tight break-words">{doc.name}</span>
          <span className="mt-0.5 truncate text-sm opacity-60">{doc.filename}</span>
        </span>
        {doc.status ? (
          <Badge variant="outline" className="text-[var(--color-fg-base)]/70">
            <Check aria-hidden />
            Ført
          </Badge>
        ) : (
          <Badge>Ikke ført</Badge>
        )}
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-sm font-normal">
        <span className="opacity-60">Mottatt {formatDay(doc.createdAt)}</span>
        <ChevronRight className="size-5 shrink-0 opacity-60" aria-hidden />
      </span>
    </Button>
  )
}

function HotelCard({ doc, onPick }: { doc: EhfDocument; onPick: () => void }) {
  const open = doc.status === "unprocessed"
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
            open
              ? "bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)]"
              : "bg-white/5 text-[var(--color-fg-base)]/60",
          )}
        >
          <Hotel className="size-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col font-normal">
          <span className="font-display text-2xl leading-tight">
            {doc.gross != null ? formatNok(doc.gross) : `Faktura ${doc.invoiceNumber ?? ""}`}
          </span>
          <span className="mt-0.5 truncate text-sm opacity-60">
            {doc.supplierName ?? "Hotellet"} · faktura {doc.invoiceNumber ?? "?"}
          </span>
        </span>
        {open ? (
          <Badge>Ikke ført</Badge>
        ) : (
          <Badge variant="outline" className="text-[var(--color-fg-base)]/70">
            <Check aria-hidden />
            Brukt
          </Badge>
        )}
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-sm font-normal">
        <span className="opacity-60">
          {doc.issueDate ? `Fakturadato ${formatDay(doc.issueDate)}` : "EHF"}
        </span>
        <ChevronRight className="size-5 shrink-0 opacity-60" aria-hidden />
      </span>
    </Button>
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
            Ført
          </Badge>
        ) : (
          <Badge>Ikke ført</Badge>
        )}
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-sm font-normal">
        <span className="opacity-60">Mottatt {formatDay(doc.createdAt)}</span>
        <span className="flex items-center gap-1 opacity-60">
          {doc.used ? "Kontroller" : null}
          <ChevronRight className="size-5 shrink-0" aria-hidden />
        </span>
      </span>
    </Button>
  )
}
