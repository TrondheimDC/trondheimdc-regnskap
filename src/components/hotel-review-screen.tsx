"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePen,
  FileText,
  ListChecks,
  OctagonX,
  ReceiptText,
  RefreshCw,
  Shapes,
  TriangleAlert,
  Undo2,
} from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { toast } from "sonner"
import { AccountPicker } from "@/components/account-picker"
import { MarkedAmount, MarkProvider, MarkRow, useMarksFor } from "@/components/marks"
import { PdfPreview } from "@/components/pdf-preview"
import { Card, CheckRow, SectionLabel, StatusBadge } from "@/components/review-screen"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { config } from "@/lib/app-config"
import type { HotelConfig } from "@/lib/config"
import type { Account, EhfDocument, Fiken } from "@/lib/fiken"
import { formatDay } from "@/lib/format"
import {
  type BillGroup,
  groupByBill,
  type HotelPlan,
  type Moves,
  type Placement,
  parseHotelInvoicePdf,
  RATE_LABEL,
} from "@/lib/hotel"
import {
  bookHotel,
  type HotelBookResult,
  type HotelFikenState,
  type HotelPrepared,
  type HotelSource,
  hotelBlockers,
  inspectHotel,
  prepareHotel,
} from "@/lib/hotel-booking"
import { buildHotelMarks } from "@/lib/marks"
import { renderPdfPage } from "@/lib/pdf-render"
import { formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"

export type HotelSelection = { kind: "ehf"; doc: EhfDocument } | { kind: "file"; file: File }

type BookMode = "draft" | "create"

async function analyze(client: Fiken, hotel: HotelConfig, selection: HotelSelection) {
  const pdf =
    selection.kind === "ehf"
      ? await client.downloadEhfDocument(selection.doc)
      : new Uint8Array(await selection.file.arrayBuffer())
  const source: HotelSource = {
    invoice: await parseHotelInvoicePdf(pdf),
    ehf: selection.kind === "ehf" ? selection.doc : undefined,
    description:
      selection.kind === "ehf" ? `EHF ${selection.doc.ehfDocumentId}` : selection.file.name,
  }
  const [fiken, preview] = await Promise.all([
    inspectHotel(client, hotel, source, { attach: true }),
    // The page is only an aid for checking; the review works without it.
    renderPdfPage(pdf, 0).catch(() => undefined),
  ])
  return { source, fiken, preview }
}

type Analysis = Awaited<ReturnType<typeof analyze>>

const hotelRecipe = () => {
  if (!config.hotel) throw new Error("Oppskriften har ingen hotellfaktura")
  return config.hotel
}

export function HotelReviewScreen({
  client,
  companyName,
  selection,
  onBack,
}: {
  client: Fiken
  companyName: string
  selection: HotelSelection
  onBack: () => void
}) {
  const hotel = hotelRecipe()
  const queryClient = useQueryClient()
  const key =
    selection.kind === "ehf"
      ? `ehf-${selection.doc.ehfDocumentId}`
      : `file-${selection.file.name}-${selection.file.size}-${selection.file.lastModified}`
  const analysis = useQuery({
    queryKey: ["hotel-analysis", client.companySlug, key],
    queryFn: () => analyze(client, hotel, selection),
  })

  // The user's choices: bills and lines moved to another category, and accounts from Fiken.
  const [moves, setMoves] = useState<Moves>({})
  const [accounts, setAccounts] = useState<Record<string, string>>({})
  const [override, setOverride] = useState(false)
  const [confirming, setConfirming] = useState<BookMode>()
  const [progress, setProgress] = useState<string[]>([])

  const source = analysis.data?.source
  const prepared = useMemo(
    () => source && prepareHotel(source, hotel, { moves, accounts }),
    [source, hotel, moves, accounts],
  )

  const booking = useMutation({
    mutationFn: (mode: BookMode) => {
      const fiken = analysis.data?.fiken
      if (!prepared || !fiken) throw new Error("Fakturaen er ikke lest ennå")
      setProgress([])
      return bookHotel(client, prepared, fiken, mode, (step) => setProgress((p) => [...p, step]))
    },
    onSuccess: (_, mode) =>
      toast.success(mode === "draft" ? "Kjøpsutkastet ligger i Fiken" : "Bokført i Fiken"),
    onError: () => toast.error("Føringen stoppet"),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["hotel-analysis"], refetchType: "none" })
      await queryClient.invalidateQueries({ queryKey: ["hotel-invoices"] })
    },
  })

  const invoice = source?.invoice
  const title = invoice ? `Faktura ${invoice.number}` : "Hotellfaktura"
  const docName =
    selection.kind === "ehf" ? (selection.doc.supplierName ?? "Hotellet") : selection.file.name
  const bookingStarted = !booking.isIdle && booking.variables !== undefined
  const refresh = () =>
    analysis.refetch().then((r) => {
      if (r.isSuccess) toast.success("Oppdatert fra Fiken")
    })

  return (
    <main className="attendee-reveal mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6 lg:px-8">
      <header className="shrink-0 pt-2">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={booking.isPending}
            className="-ml-3"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Tilbake
          </Button>
          {bookingStarted ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={analysis.isFetching}
              className="-mr-3 text-[var(--color-fg-base)]/70"
            >
              <RefreshCw
                className={cn("size-4", analysis.isFetching && "animate-spin")}
                aria-hidden
              />
              Oppdater
            </Button>
          )}
        </div>
        <h1 className="mt-2 text-4xl">{title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-fg-base)]/60">
          <span>{companyName}</span>
          <span aria-hidden>·</span>
          <span className="break-all">{docName}</span>
          {selection.kind === "ehf" ? <Badge variant="outline">EHF</Badge> : null}
          {selection.kind === "file" ? <Badge variant="outline">Lokal fil</Badge> : null}
        </p>
      </header>

      {analysis.isPending ? (
        <div
          className="flex min-h-[60svh] flex-col items-center justify-center gap-3 rounded-xl bg-[var(--color-bg-surface)]/50 text-sm text-[var(--color-fg-base)]/70"
          aria-busy="true"
        >
          <Spinner className="size-6" />
          Leser fakturaen og sjekker Fiken…
        </div>
      ) : null}

      {analysis.isError ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>
            {analysis.data ? "Klarte ikke å oppdatere fra Fiken" : "Klarte ikke å lese fakturaen"}
          </AlertTitle>
          <AlertDescription>{analysis.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {analysis.data && prepared && !bookingStarted ? (
        <HotelReview
          hotel={hotel}
          data={analysis.data}
          prepared={prepared}
          moves={moves}
          onMove={(key, category, lineKeys = []) =>
            setMoves((m) => {
              // Moving a bill takes its lines along, also ones moved on their own before.
              const next = Object.fromEntries(
                Object.entries(m).filter(([k]) => !lineKeys.includes(k)),
              )
              next[key] = category
              return next
            })
          }
          onReset={() => setMoves({})}
          accounts={accounts}
          onAccount={(category, account) => setAccounts((a) => ({ ...a, [category]: account }))}
          override={override}
          onOverride={setOverride}
          onBook={setConfirming}
          disabled={booking.isPending}
        />
      ) : null}

      {bookingStarted && booking.variables ? (
        <div className="mx-auto w-full max-w-2xl">
          <BookingStatus
            mode={booking.variables}
            progress={progress}
            result={booking.data}
            error={booking.error}
            pending={booking.isPending}
            onDone={onBack}
          />
        </div>
      ) : null}

      {analysis.data && prepared ? (
        <ConfirmDialog
          prepared={prepared}
          fiken={analysis.data.fiken}
          mode={confirming}
          companyName={companyName}
          onCancel={() => setConfirming(undefined)}
          onConfirm={(mode) => {
            booking.mutate(mode)
            setConfirming(undefined)
          }}
        />
      ) : null}
    </main>
  )
}

function ConfirmDialog({
  prepared: { plan, source },
  fiken,
  mode,
  companyName,
  onCancel,
  onConfirm,
}: {
  prepared: HotelPrepared
  fiken: HotelFikenState
  mode?: BookMode
  companyName: string
  onCancel: () => void
  onConfirm: (mode: BookMode) => void
}) {
  const supplier = fiken.supplier?.name ?? source.invoice.supplierName ?? "hotellet"
  return (
    <AlertDialog open={mode !== undefined} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === "draft" ? "Lag kjøpsutkast i Fiken?" : "Bokfør i Fiken?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {[
              `Kjøp på ${formatNok(plan.gross)} fra ${supplier} blir ${mode === "draft" ? "et utkast" : "bokført"} i ${companyName}, med ${plan.lines.length} linjer og fakturaen vedlagt.`,
              `Det står som ubetalt leverandørgjeld${plan.dueDate ? ` med forfall ${formatDay(plan.dueDate)}` : ""} til betalingen kommer på banken.`,
              mode === "create" && "Bokførte bilag kan bare rettes ved å annullere dem i Fiken.",
            ]
              .filter(Boolean)
              .join(" ")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction onClick={() => mode && onConfirm(mode)}>
            {mode === "draft" ? "Lag utkast" : "Bokfør"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function HotelReview({
  hotel,
  data: { fiken, preview, source },
  prepared,
  moves,
  onMove,
  onReset,
  accounts,
  onAccount,
  override,
  onOverride,
  onBook,
  disabled,
}: {
  hotel: HotelConfig
  data: Analysis
  prepared: HotelPrepared
  moves: Moves
  onMove: (key: string, category: string, lineKeys?: string[]) => void
  onReset: () => void
  accounts: Record<string, string>
  onAccount: (category: string, account: string) => void
  override: boolean
  onOverride: (v: boolean) => void
  onBook: (mode: BookMode) => void
  disabled: boolean
}) {
  const { plan, checks } = prepared
  const blockers = hotelBlockers(prepared, fiken)
  const failed = checks.filter((c) => !c.ok).length
  const blocked = blockers.length > 0
  const canBook = !blocked && (failed === 0 || override) && !disabled
  const marks = useMemo(() => buildHotelMarks(source.invoice), [source.invoice])
  const [pdfOpen, setPdfOpen] = useState(true)
  const revealPdf = useMemo(() => () => setPdfOpen(true), [])
  const groups = useMemo(() => groupByBill(plan.placements), [plan.placements])
  const moved = Object.keys(moves).length

  return (
    <MarkProvider marks={marks} onReveal={revealPdf}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3 lg:order-2 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
          <SectionLabel>Fakturaen</SectionLabel>
          {preview ? (
            <PdfPreview image={preview} marks={marks} open={pdfOpen} onOpenChange={setPdfOpen} />
          ) : (
            <Alert>
              <FileText aria-hidden />
              <AlertTitle>Klarte ikke å vise fakturaen</AlertTitle>
              <AlertDescription>
                Tallene er likevel lest. Åpne fakturaen i Fiken for å sammenligne.
              </AlertDescription>
            </Alert>
          )}
          <InvoiceSummary plan={plan} prepared={prepared} />
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:order-1">
          <Totals prepared={prepared} blocked={blocked} failed={failed} />

          <div className="flex flex-col gap-3">
            <SectionLabel>Kjøpet</SectionLabel>
            <PurchaseCard plan={plan} fiken={fiken} />
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel
              aside={
                moved > 0 ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={onReset}
                    className="text-[var(--color-fg-base)]/70"
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                    Tilbakestill {moved} {moved === 1 ? "flytting" : "flyttinger"}
                  </Button>
                ) : null
              }
            >
              Kategorier
            </SectionLabel>
            <p className="-mt-1 text-xs text-[var(--color-fg-base)]/50">
              Oppskriften foreslår en kategori per linje. Flytt en regning eller en linje hvis den
              hører hjemme et annet sted.
            </p>
            {plan.unplaced.length > 0 ? (
              <CategoryCard
                hotel={hotel}
                groups={groups}
                plan={plan}
                fikenAccounts={fiken.accounts}
                onMove={onMove}
              />
            ) : null}
            {hotel.categories.map((c) => (
              <CategoryCard
                key={c.id}
                hotel={hotel}
                category={c.id}
                groups={groups}
                plan={plan}
                fikenAccounts={fiken.accounts}
                account={accounts[c.id] ?? c.account}
                onAccount={(a) => onAccount(c.id, a)}
                onMove={onMove}
              />
            ))}
          </div>

          <ChecksCard checks={checks} blockers={blockers} />

          {!blocked ? (
            <div className="flex flex-col gap-3">
              {failed > 0 ? (
                <div className="flex items-start gap-3 rounded-xl bg-[var(--color-bg-surface)] px-4 py-3.5">
                  <Checkbox
                    id="override"
                    checked={override}
                    onCheckedChange={(v) => onOverride(v === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="override" className="font-normal leading-snug">
                    Jeg har sett avvikene og vil føre likevel.
                  </Label>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  disabled={!canBook}
                  onClick={() => onBook("create")}
                  className="w-full sm:order-2"
                >
                  <CircleCheck className="size-5" aria-hidden />
                  Bokfør
                </Button>
                <Button
                  variant="surface"
                  disabled={!canBook}
                  onClick={() => onBook("draft")}
                  className="w-full"
                >
                  <FilePen className="size-5" aria-hidden />
                  Lag utkast
                </Button>
              </div>
              <p className="text-xs text-[var(--color-fg-base)]/50">
                «Lag utkast» legger kjøpet i Fiken uten å bokføre, så du kan se over der først.
                «Bokfør» fører det med en gang som ubetalt leverandørgjeld.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </MarkProvider>
  )
}

function Totals({
  prepared: { plan, source },
  blocked,
  failed,
}: {
  prepared: HotelPrepared
  blocked: boolean
  failed: number
}) {
  const items = [
    { label: "Fakturadato", value: formatDay(plan.date) },
    { label: "Forfall", value: plan.dueDate ? formatDay(plan.dueDate) : "–" },
    { label: "Fakturatotal", value: formatNok(source.invoice.total) },
  ]
  return (
    <section className="@container flex flex-col gap-3 rounded-xl bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-fg-base)]/60">
          {source.invoice.supplierName ?? "Hotellet"}
          {plan.kid ? ` · KID ${plan.kid}` : ""}
        </p>
        <StatusBadge blocked={blocked} failed={failed} />
      </div>
      <dl className="grid gap-x-4 gap-y-2 @xl:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-baseline justify-between gap-3 @xl:flex-col @xl:items-start @xl:gap-0.5"
          >
            <dt className="text-sm text-[var(--color-fg-base)]/60">{item.label}</dt>
            <dd className="tabular text-lg">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const vatText = (l: HotelPlan["lines"][number]) =>
  l.rate === 0
    ? "uten mva"
    : l.deduct
      ? `${RATE_LABEL(l.rate)}, fradrag`
      : `${RATE_LABEL(l.rate)}, uten fradrag`

function PurchaseCard({ plan, fiken }: { plan: HotelPlan; fiken: HotelFikenState }) {
  const total = useMarksFor(["total"])
  const supplier = fiken.supplier
  return (
    <Card
      icon={<ReceiptText />}
      title="Leverandørkjøp"
      subtitle={[
        "Ikke betalt",
        supplier && `${supplier.name}${supplier.accountCode ? ` (${supplier.accountCode})` : ""}`,
        `referanse ${plan.reference}`,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <ul className="mt-4 flex flex-col gap-1">
        {plan.lines.map((l) => (
          <li key={`${l.category}-${l.rate}`} className="py-1.5">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-semibold">{l.description}</span>
                <span className="block text-sm text-[var(--color-fg-base)]/60">
                  Konto {l.account} · {vatText(l)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <MarkedAmount marks={[]}>{formatNok(l.netPrice)}</MarkedAmount>
                {l.vat ? (
                  <MarkedAmount marks={[]} className="text-sm text-[var(--color-fg-base)]/70">
                    mva {formatNok(l.vat)}
                  </MarkedAmount>
                ) : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
        <span className="text-sm text-[var(--color-fg-base)]/70">Sum inkl. mva</span>
        <MarkedAmount marks={total} className="text-xl">
          {formatNok(plan.gross)}
        </MarkedAmount>
      </div>
    </Card>
  )
}

/** A category with its account, its purchase lines and the bills in it; or the unplaced lines. */
function CategoryCard({
  hotel,
  category,
  groups,
  plan,
  fikenAccounts,
  account,
  onAccount,
  onMove,
}: {
  hotel: HotelConfig
  /** Undefined: the lines without a category. */
  category?: string
  groups: BillGroup[]
  plan: HotelPlan
  fikenAccounts: Account[]
  account?: string
  onAccount?: (account: string) => void
  onMove: (key: string, category: string, lineKeys?: string[]) => void
}) {
  const known = new Set(hotel.categories.map((c) => c.id))
  const inCategory = (p: Placement) =>
    category === undefined ? !p.category || !known.has(p.category) : p.category === category
  const bills = groups
    .map((g) => ({ ...g, placements: g.placements.filter(inCategory) }))
    .filter((g) => g.placements.length > 0)
  const sum = bills.flatMap((g) => g.placements).reduce((s, p) => s + p.line.gross, 0)
  const lines = plan.lines.filter((l) => l.category === category)
  const def = hotel.categories.find((c) => c.id === category)
  const rooms = bills.filter((b) => b.section === "Stay")
  const other = bills.filter((b) => b.section !== "Stay")
  const unplaced = category === undefined

  return (
    <Card
      icon={unplaced ? <TriangleAlert /> : <Shapes />}
      title={unplaced ? "Uten kategori" : (def?.label ?? category)}
      subtitle={
        unplaced
          ? "Disse linjene må flyttes til en kategori før fakturaen kan føres."
          : lines.map(vatText).join(" · ") || "Ingen linjer på denne fakturaen"
      }
      aside={<span className="tabular shrink-0 pt-0.5 text-lg">{formatNok(sum)}</span>}
      className={cn(
        unplaced && "ring-1 ring-[var(--color-bg-danger)]",
        !unplaced && bills.length === 0 && "bg-[var(--color-bg-surface)]/50",
      )}
    >
      {onAccount && account ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label htmlFor={`account-${category}`} className="text-sm text-[var(--color-fg-base)]/70">
            Konto i Fiken
          </label>
          <AccountPicker
            id={`account-${category}`}
            value={account}
            suggested={def?.account}
            accounts={fikenAccounts}
            onChange={onAccount}
          />
        </div>
      ) : null}

      {bills.length > 0 ? (
        <details className="group mt-4 border-t border-white/10 pt-3" open={unplaced}>
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-[var(--color-fg-base)]/70 hover:text-[var(--color-fg-base)] [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-4 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {[
              other.length > 0 && `${other.length} ${other.length === 1 ? "regning" : "regninger"}`,
              rooms.length > 0 && `${rooms.length} romregninger`,
            ]
              .filter(Boolean)
              .join(" og ")}
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {other.map((g) => (
              <BillRow key={g.key} hotel={hotel} group={g} full={groups} onMove={onMove} />
            ))}
            {rooms.length > 0 ? (
              <li>
                <details className="group/rooms">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2">
                      <ChevronRight
                        className="size-4 shrink-0 transition-transform group-open/rooms:rotate-90"
                        aria-hidden
                      />
                      <span className="font-semibold">Stay</span>
                      <span className="text-[var(--color-fg-base)]/60">
                        {rooms.length} romregninger
                      </span>
                    </span>
                    <span className="tabular">
                      {formatNok(
                        rooms.reduce(
                          (s, g) => s + g.placements.reduce((t, p) => t + p.line.gross, 0),
                          0,
                        ),
                      )}
                    </span>
                  </summary>
                  <ul className="mt-3 flex flex-col gap-3 pl-6">
                    {rooms.map((g) => (
                      <BillRow key={g.key} hotel={hotel} group={g} full={groups} onMove={onMove} />
                    ))}
                  </ul>
                </details>
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </Card>
  )
}

/** A bill with a picker that moves all of it; its lines can be moved one by one. */
function BillRow({
  hotel,
  group,
  full,
  onMove,
}: {
  hotel: HotelConfig
  /** The bill's lines in this category. */
  group: BillGroup
  /** All bills, to know whether the bill is split across categories. */
  full: BillGroup[]
  onMove: (key: string, category: string, lineKeys?: string[]) => void
}) {
  const whole = full.find((g) => g.key === group.key) ?? group
  const categories = new Set(whole.placements.map((p) => p.category))
  const current = categories.size === 1 ? [...categories][0] : undefined
  const lineKeys = whole.placements.map((p) => `#${p.line.n}`)
  const sum = group.placements.reduce((s, p) => s + p.line.gross, 0)
  const single = whole.placements.length === 1

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="min-w-0 text-sm">
          <span className="font-semibold tabular-nums">{group.bill ?? group.section}</span>{" "}
          <span className="text-[var(--color-fg-base)]/60">
            {group.bill ? group.section : ""}
            {single ? ` · #${group.placements[0]?.line.n} ${group.placements[0]?.line.text}` : ""}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular text-sm">{formatNok(sum)}</span>
          <CategorySelect
            hotel={hotel}
            label={`Flytt ${group.bill ?? `linje ${group.key}`} til kategori`}
            value={current}
            mixed={categories.size > 1}
            onChange={(c) => onMove(group.bill ?? group.key, c, lineKeys)}
          />
        </span>
      </div>
      {single ? null : (
        <ul className="flex flex-col border-l border-white/10 pl-3">
          {group.placements.map((p) => (
            <li
              key={p.line.n}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 text-sm"
            >
              <span className="min-w-0 text-[var(--color-fg-base)]/80">
                <span className="text-[var(--color-fg-base)]/50 tabular-nums">#{p.line.n}</span>{" "}
                {p.line.text}
                {p.by === "line" || p.by === "bill" ? (
                  <span className="text-[var(--color-fg-warning)]"> · flyttet</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular">{formatNok(p.line.gross)}</span>
                <CategorySelect
                  hotel={hotel}
                  label={`Flytt linje ${p.line.n} til kategori`}
                  value={p.category}
                  onChange={(c) => onMove(`#${p.line.n}`, c)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

const selectClass =
  "h-8 max-w-[14rem] cursor-pointer truncate rounded-lg border border-white/15 bg-[var(--color-bg-base)] px-2 text-sm text-[var(--color-fg-base)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-fg-brand)]"

function CategorySelect({
  hotel,
  label,
  value,
  mixed = false,
  onChange,
}: {
  hotel: HotelConfig
  label: string
  value?: string
  mixed?: boolean
  onChange: (category: string) => void
}) {
  const known = value !== undefined && hotel.categories.some((c) => c.id === value)
  return (
    <select
      aria-label={label}
      value={known ? value : ""}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className={selectClass}
    >
      {!known ? (
        <option value="" disabled>
          {mixed ? "Flere kategorier" : "Velg kategori"}
        </option>
      ) : null}
      {hotel.categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  )
}

/** Page 1 of the invoice as read: sums per section and rate, VAT and total, with their marks. */
function InvoiceSummary({ plan, prepared }: { plan: HotelPlan; prepared: HotelPrepared }) {
  const { invoice } = prepared.source
  const rows = [
    ...invoice.sections.map((s) => ({
      key: `section:${s.section}:${s.rate}`,
      label: `${s.section} ${s.rate} %`,
      amount: s.gross,
    })),
    ...invoice.vatSpec.map((v) => ({
      key: `vat:${v.rate}`,
      label: `Mva ${v.rate} %`,
      amount: v.vat,
    })),
    { key: "total", label: "Fakturatotal", amount: invoice.total },
  ]
  return (
    <details className="group rounded-xl bg-[var(--color-bg-surface)]/60 p-4 text-sm sm:p-5">
      <summary className="cursor-pointer font-semibold text-[var(--color-fg-base)]/80">
        Slik er fakturaen lest
      </summary>
      <p className="mt-2 text-xs text-[var(--color-fg-base)]/50">
        Summene på side 1, som linjene på de neste sidene ({invoice.lines.length} stk.) kontrolleres
        mot. Romlinjene deles på 12 % og 25 % slik side 1 viser.
      </p>
      <ul className="mt-3 flex flex-col">
        {rows.map((r) => (
          <SummaryRow key={r.key} markKey={r.key} label={r.label} amount={r.amount} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-[var(--color-fg-base)]/50">
        Referanse i Fiken: {plan.reference}
      </p>
    </details>
  )
}

function SummaryRow({
  markKey,
  label,
  amount,
}: {
  markKey: string
  label: string
  amount: number
}) {
  const marks = useMarksFor([markKey])
  return (
    <MarkRow marks={marks} className="py-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[var(--color-fg-base)]/70">{label}</span>
        <MarkedAmount marks={marks}>{formatNok(amount)}</MarkedAmount>
      </div>
    </MarkRow>
  )
}

function ChecksCard({ checks, blockers }: { checks: HotelPrepared["checks"]; blockers: string[] }) {
  const failed = checks.filter((c) => !c.ok)
  const passed = checks.filter((c) => c.ok)
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Kontroller</SectionLabel>
      {blockers.length > 0 ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>Kan ikke føres</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card
        icon={<ListChecks />}
        title={failed.length === 0 ? "Alt stemmer" : `${failed.length} av ${checks.length} avviker`}
        subtitle="Linjene mot side 1, mva-spesifikasjonen og fakturatotal"
      >
        {failed.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-3">
            {failed.map((c) => (
              <CheckRow key={c.label} check={c} />
            ))}
          </ul>
        ) : null}
        <details className="group mt-4 border-t border-white/10 pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-[var(--color-fg-base)]/70 hover:text-[var(--color-fg-base)] [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-4 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {failed.length === 0
              ? `Vis de ${checks.length} kontrollene`
              : `Vis de ${passed.length} som stemmer`}
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {passed.map((c) => (
              <CheckRow key={c.label} check={c} />
            ))}
          </ul>
        </details>
      </Card>
    </div>
  )
}

function BookingStatus({
  mode,
  progress,
  result,
  error,
  pending,
  onDone,
}: {
  mode: BookMode
  progress: string[]
  result?: HotelBookResult
  error: Error | null
  pending: boolean
  onDone: () => void
}) {
  const totalOk = result?.total ? result.total.actual === result.total.expected : undefined
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>
        {pending
          ? "Fører i Fiken…"
          : error
            ? "Føringen stoppet"
            : mode === "draft"
              ? "Kjøpsutkastet ligger i Fiken"
              : "Bokført i Fiken"}
      </SectionLabel>
      <section className="rounded-xl bg-[var(--color-bg-surface)] p-4 sm:p-5">
        <ul className="space-y-3">
          {progress.map((s) => (
            <StatusRow key={s} ok>
              {s}
            </StatusRow>
          ))}
          {result?.total ? (
            <StatusRow ok={totalOk === true}>
              Kjøpet i Fiken: <span className="tabular">{formatNok(result.total.actual)}</span>
              {!totalOk
                ? ` (forventet ${formatNok(result.total.expected)} – sjekk kjøpet i Fiken)`
                : ""}
            </StatusRow>
          ) : null}
          {pending ? (
            <li className="flex items-center gap-3 text-[var(--color-fg-base)]/70">
              <Spinner className="size-5" />
              Ikke lukk siden før føringen er ferdig
            </li>
          ) : null}
        </ul>
      </section>

      {error ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>Fiken avviste et steg</AlertTitle>
          <AlertDescription>
            <p className="select-text break-all font-mono text-xs">{error.message}</p>
            <p>Det som er merket ✓ ligger i Fiken. Resten må du føre eller rydde opp i Fiken.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {!pending ? (
        <Button variant="surface" onClick={onDone} className="w-full">
          Tilbake til innboksen
        </Button>
      ) : null}
    </div>
  )
}

function StatusRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      {ok ? (
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-brand)]" aria-hidden />
      ) : (
        <CircleX className="mt-0.5 size-5 shrink-0 text-[var(--color-bg-danger)]" aria-hidden />
      )}
      <span>{children}</span>
    </li>
  )
}
