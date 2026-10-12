"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Coins,
  FilePen,
  FileText,
  Landmark,
  ListChecks,
  OctagonX,
  ReceiptText,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { type ComponentProps, type ReactNode, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  MarkedAmount,
  MarkProvider,
  MarkRow,
  MarkScope,
  useMarkArea,
  useMarks,
  useMarksFor,
} from "@/components/marks"
import { PdfPreview } from "@/components/pdf-preview"
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
import {
  type Audit,
  auditBooked,
  type BookedVoucher,
  type BookResult,
  book,
  bookable,
  bookRounding,
  type Existing,
  type FikenState,
  inspectFiken,
  PARTS,
  type Part,
  type Parts,
  type Prepared,
  prepare,
  type ReportDocument,
  type ReportSource,
  type Transfer,
} from "@/lib/booking"
import { parseReportPdf } from "@/lib/checkin"
import type { Fiken, OrderLine } from "@/lib/fiken"
import { formatDay, formatMonth } from "@/lib/format"
import {
  bookedLineKeys,
  buildMarks,
  checkKeys,
  lineKeys,
  type Mark,
  payoutKey,
  vatKey,
} from "@/lib/marks"
import { renderPdfPage } from "@/lib/pdf-render"
import { formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"
import { type Check, explainRounding, isRoundingCheck, type RoundingCorrection } from "@/lib/verify"

export type Selection = { kind: "inbox"; doc: ReportDocument } | { kind: "file"; file: File }

type BookMode = "draft" | "create"

async function analyze(client: Fiken, selection: Selection) {
  const pdf =
    selection.kind === "inbox"
      ? await client.downloadInboxDocument(selection.doc)
      : new Uint8Array(await selection.file.arrayBuffer())
  // parseReportPdf hands pdf.js a copy, so `pdf` stays usable for rendering.
  const source: ReportSource = {
    ...(await parseReportPdf(pdf)),
    doc: selection.kind === "inbox" ? selection.doc : undefined,
    description: selection.kind === "inbox" ? selection.doc.name : selection.file.name,
  }

  const prepared = prepare(source, config)
  const summaryPage = Math.min(...Object.values(source.boxes).map((b) => b.page))
  const [state, preview] = await Promise.all([
    inspect(client, prepared),
    // The page is only an aid for checking; the review works without it.
    Number.isFinite(summaryPage)
      ? renderPdfPage(pdf, summaryPage).catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  return { prepared, ...state, pdf, preview }
}

/**
 * A month with everything booked is checked against Fiken. Otherwise what is missing can be
 * booked; drafts left in Fiken keep the month here, so they are not mistaken for booked.
 */
async function inspect(
  client: Fiken,
  prepared: Prepared,
): Promise<{ audit: Audit; fiken?: undefined } | { fiken: FikenState; audit?: undefined }> {
  const fiken = await inspectFiken(client, config, prepared, { attach: true })
  const { sale, purchase } = fiken.existing
  const vouchers = (e?: Existing) => (e?.status === "booked" ? e.vouchers : [])
  if (
    Object.values(bookable(prepared, fiken)).some(Boolean) ||
    sale?.status === "draft" ||
    purchase?.status === "draft"
  )
    return { fiken }
  return {
    audit: await auditBooked(client, config, prepared, {
      sales: vouchers(sale),
      purchases: vouchers(purchase),
    }),
  }
}

/** The parts to book: what is left in Fiken, minus what the user unticked. */
function chosenParts(open: Parts, picked: Partial<Parts>): Parts {
  return Object.fromEntries(PARTS.map((p) => [p, open[p] && (picked[p] ?? true)])) as Parts
}

type Analysis = Awaited<ReturnType<typeof analyze>> & { fiken: FikenState }
type AuditAnalysis = Awaited<ReturnType<typeof analyze>> & { audit: Audit }

function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm tracking-wide text-[var(--color-fg-brand)]">{children}</p>
      {aside}
    </div>
  )
}

/**
 * A card on the review screen. With `marks` (a sale, purchase or payout), hovering the card
 * emphasises all its numbers on the PDF; a line inside narrows it to its own.
 */
function Card({
  icon,
  title,
  subtitle,
  aside,
  marks = [],
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  marks?: Mark[]
}) {
  const { on, props: hover, scope } = useMarkArea(marks)
  return (
    <section
      {...props}
      {...hover}
      className={cn(
        "rounded-xl bg-[var(--color-bg-surface)] p-4 transition-colors duration-150 sm:p-5",
        className,
        on && "bg-[color-mix(in_srgb,var(--color-bg-surface)_88%,var(--color-white-1))]",
      )}
    >
      <MarkScope marks={scope}>
        <header className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)] [&_svg]:size-[1.125rem]">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl leading-tight">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-sm text-[var(--color-fg-base)]/60">{subtitle}</p>
            ) : null}
          </div>
          {aside}
        </header>
        {children}
      </MarkScope>
    </section>
  )
}

export function ReviewScreen({
  client,
  companyName,
  selection,
  onBack,
}: {
  client: Fiken
  companyName: string
  selection: Selection
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const key =
    selection.kind === "inbox"
      ? `inbox-${selection.doc.documentId}`
      : `file-${selection.file.name}-${selection.file.size}-${selection.file.lastModified}`
  const analysis = useQuery({
    queryKey: ["analysis", client.companySlug, key],
    queryFn: () => analyze(client, selection),
  })

  const [override, setOverride] = useState(false)
  const [picked, setPicked] = useState<Partial<Parts>>({})
  const [confirming, setConfirming] = useState<BookMode>()
  const [progress, setProgress] = useState<string[]>([])
  const parts =
    analysis.data?.fiken &&
    chosenParts(bookable(analysis.data.prepared, analysis.data.fiken), picked)
  const booking = useMutation({
    mutationFn: (mode: BookMode) => {
      const { prepared, fiken } = analysis.data ?? {}
      if (!prepared || !fiken || !parts) throw new Error("Bilaget er ikke lest ennå")
      setProgress([])
      return book(client, config, prepared, fiken, mode, parts, (step) =>
        setProgress((p) => [...p, step]),
      )
    },
    onSuccess: (_, mode) =>
      toast.success(mode === "draft" ? "Utkastene ligger i Fiken" : "Bokført i Fiken"),
    onError: () => toast.error("Føringen stoppet"),
    onSettled: async () => {
      // Opening the bilag again should show what was booked, not the plan from before.
      await queryClient.invalidateQueries({ queryKey: ["analysis"], refetchType: "none" })
      await queryClient.invalidateQueries({ queryKey: ["inbox"] })
    },
  })

  // A booked month that is a few øre off: the one thing that can be booked from the audit.
  const rounding = useMutation({
    mutationFn: () => {
      const { prepared, audit } = analysis.data ?? {}
      if (!prepared || !audit) throw new Error("Bilaget er ikke lest ennå")
      return bookRounding(client, config, prepared, audit, "create")
    },
    onSuccess: async () => {
      toast.success("Øreavrunding bokført i Fiken")
      await analysis.refetch()
    },
    onError: () => toast.error("Øreavrundingen ble ikke ført"),
  })

  const month =
    analysis.data?.prepared.month ?? (selection.kind === "inbox" ? selection.doc.month : undefined)
  const title = month ? formatMonth(month) : "Regnskapsbilag"
  const docName = selection.kind === "inbox" ? selection.doc.name : selection.file.name
  const bookingStarted = !booking.isIdle && booking.variables !== undefined
  // After fixing something in Fiken: read Fiken (and the bilag) again. The old numbers stay
  // on screen until the new ones are in.
  const refresh = () =>
    analysis.refetch().then((r) => {
      if (r.isSuccess) toast.success("Oppdatert fra Fiken")
    })

  return (
    <main className="attendee-reveal mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6 lg:px-8">
      <header className="shrink-0 pt-2">
        <div className="flex min-h-9 items-center justify-between gap-3">
          {/* -ml-3 lines the arrow up with the title below. */}
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
        {analysis.data?.audit ? (
          <p className="mt-1 text-[var(--color-fg-base)]/80">
            Måneden er ført. Her ser du om føringen stemmer med bilaget.
          </p>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-fg-base)]/60">
          <span>{companyName}</span>
          <span aria-hidden>·</span>
          <span className="break-all">{docName}</span>
          {selection.kind === "inbox" && selection.doc.used ? (
            <Badge variant="outline">Ført</Badge>
          ) : null}
          {selection.kind === "file" ? <Badge variant="outline">Lokal fil</Badge> : null}
        </p>
      </header>

      {analysis.isPending ? (
        <div
          className="flex min-h-[60svh] flex-col items-center justify-center gap-3 rounded-xl bg-[var(--color-bg-surface)]/50 text-sm text-[var(--color-fg-base)]/70"
          aria-busy="true"
        >
          <Spinner className="size-6" />
          Leser bilaget og sjekker Fiken…
        </div>
      ) : null}

      {analysis.isError ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>
            {analysis.data ? "Klarte ikke å oppdatere fra Fiken" : "Klarte ikke å lese bilaget"}
          </AlertTitle>
          <AlertDescription>{analysis.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {analysis.data?.audit && !bookingStarted ? (
        <AuditReview
          data={{ ...analysis.data, audit: analysis.data.audit }}
          companyName={companyName}
          rounding={{
            pending: rounding.isPending,
            error: rounding.error,
            onBook: () => rounding.mutate(),
          }}
        />
      ) : null}

      {analysis.data?.fiken && parts && !bookingStarted ? (
        <Review
          data={{ ...analysis.data, fiken: analysis.data.fiken }}
          parts={parts}
          onPart={(part, on) => setPicked((p) => ({ ...p, [part]: on }))}
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

      {analysis.data?.fiken && parts ? (
        <ConfirmDialog
          data={{ ...analysis.data, fiken: analysis.data.fiken }}
          parts={parts}
          mode={confirming}
          title={title}
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
  data: { prepared, fiken },
  parts,
  mode,
  title,
  companyName,
  onCancel,
  onConfirm,
}: {
  data: Analysis
  parts: Parts
  mode?: BookMode
  title: string
  companyName: string
  onCancel: () => void
  onConfirm: (mode: BookMode) => void
}) {
  const { plan } = prepared
  const newTransfers = fiken.transfers.filter((t) => !t.existing)
  const moved = newTransfers.reduce((s, t) => s + t.amount, 0)
  const payouts =
    newTransfers.length === 1
      ? `Utbetalingen på ${formatNok(moved)}`
      : `${newTransfers.length} utbetalinger på til sammen ${formatNok(moved)}`
  const route = `fra ${config.checkinAccount} til ${config.bankAccount}`
  const vouchers = [
    parts.sale && `salg på ${formatNok(plan.sale.gross)}`,
    parts.purchase && `kjøp på ${formatNok(plan.purchase.gross)}`,
  ].filter((v) => typeof v === "string")
  const what = vouchers.join(" og ")
  const capitalized = what.charAt(0).toUpperCase() + what.slice(1)
  const transfers = parts.transfers
    ? mode === "draft"
      ? `${payouts} blir åpne fri posteringer ${route}. De kan slettes uten motpostering.`
      : `${payouts} blir ført som fri posteringer ${route}.`
    : ""

  return (
    <AlertDialog open={mode !== undefined} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === "draft" ? "Lag utkast i Fiken?" : "Bokfør i Fiken?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {[
              what &&
                `${capitalized} for ${title} blir ${mode === "draft" ? "utkast" : "bokført"} i ${companyName}, med bilaget vedlagt.`,
              transfers,
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

function Review({
  data,
  parts,
  onPart,
  override,
  onOverride,
  onBook,
  disabled,
}: {
  data: Analysis
  parts: Parts
  onPart: (part: Part, on: boolean) => void
  override: boolean
  onOverride: (v: boolean) => void
  onBook: (mode: BookMode) => void
  disabled: boolean
}) {
  const { prepared, fiken, preview } = data
  const checks = [...prepared.checks, ...fiken.checks]
  const failed = checks.filter((c) => !c.ok).length
  const blocked = fiken.blockers.length > 0
  const anything = PARTS.some((p) => parts[p])
  const canBook = !blocked && anything && (failed === 0 || override) && !disabled

  return (
    <ReviewLayout prepared={prepared} preview={preview}>
      <Totals prepared={prepared} blocked={blocked} failed={failed} />

      <div className="flex flex-col gap-3">
        <SectionLabel>Salg og kjøp</SectionLabel>
        <SideCard side="sale" prepared={prepared} fiken={fiken} />
        {prepared.plan.purchase.lines.length > 0 || fiken.existing.purchase ? (
          <SideCard side="purchase" prepared={prepared} fiken={fiken} />
        ) : null}
      </div>

      {fiken.transfers.length > 0 ? (
        <div className="flex flex-col gap-3">
          <SectionLabel
            aside={
              <span className="text-xs text-[var(--color-fg-base)]/60">
                {fiken.transfers.filter((t) => !t.existing).length} av {fiken.transfers.length} skal
                føres
              </span>
            }
          >
            Utbetalinger
          </SectionLabel>
          {fiken.transfers.map((t) => (
            <TransferCard key={t.voucher} transfer={t} />
          ))}
        </div>
      ) : null}

      <ChecksCard checks={checks} blockers={fiken.blockers} />

      <MappingDetails prepared={prepared} />

      {!blocked ? (
        <div className="flex flex-col gap-3">
          <PartsCard prepared={prepared} fiken={fiken} parts={parts} onPart={onPart} />
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
            «Lag utkast» legger det valgte i Fiken uten å bokføre, så du kan se over der først.
            «Bokfør» fører det med en gang.
          </p>
        </div>
      ) : null}
    </ReviewLayout>
  )
}

const existingText = (e: Existing) =>
  e.status === "draft" ? "Ligger som utkast i Fiken" : "Allerede bokført i Fiken"

/** Which parts of the month to book now. A part already in Fiken can't be picked. */
function PartsCard({
  prepared,
  fiken,
  parts,
  onPart,
}: {
  prepared: Prepared
  fiken: FikenState
  parts: Parts
  onPart: (part: Part, on: boolean) => void
}) {
  const open = bookable(prepared, fiken)
  const newTransfers = fiken.transfers.filter((t) => !t.existing)
  const rows: { part: Part; label: string; amount?: number; note?: string }[] = [
    {
      part: "sale",
      label: "Salg",
      amount: prepared.plan.sale.gross,
      note: fiken.existing.sale && existingText(fiken.existing.sale),
    },
    ...(prepared.plan.purchase.lines.length > 0 || fiken.existing.purchase
      ? [
          {
            part: "purchase" as const,
            label: "Kjøp",
            amount: prepared.plan.purchase.gross,
            note: fiken.existing.purchase && existingText(fiken.existing.purchase),
          },
        ]
      : []),
    ...(fiken.transfers.length > 0
      ? [
          {
            part: "transfers" as const,
            label: newTransfers.length === 1 ? "Utbetaling" : `${newTransfers.length} utbetalinger`,
            amount: newTransfers.reduce((s, t) => s + t.amount, 0),
            note: open.transfers ? "Fri postering til bank" : "Allerede ført i Fiken",
          },
        ]
      : []),
  ]

  return (
    <Card
      icon={<ListChecks />}
      title="Dette føres"
      subtitle="Fjern haken for det du vil føre senere."
    >
      <ul className="mt-4 flex flex-col gap-1">
        {rows.map(({ part, label, amount, note }) => (
          <li key={part}>
            <Label
              htmlFor={`part-${part}`}
              className={cn(
                "flex items-start gap-3 rounded-lg px-1 py-2 font-normal",
                !open[part] && "opacity-60",
              )}
            >
              <Checkbox
                id={`part-${part}`}
                checked={parts[part]}
                disabled={!open[part]}
                onCheckedChange={(v) => onPart(part, v === true)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{label}</span>
                {note ? (
                  <span className="block text-sm text-[var(--color-fg-base)]/60">{note}</span>
                ) : null}
              </span>
              {amount !== undefined && open[part] ? (
                <span className="tabular shrink-0">{formatNok(amount)}</span>
              ) : null}
            </Label>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The bilag with its marks beside the cards; the PDF goes first on mobile. */
function ReviewLayout({
  prepared,
  preview,
  children,
}: {
  prepared: Prepared
  preview: Analysis["preview"]
  children: ReactNode
}) {
  const marks = useMemo(() => buildMarks(prepared, config), [prepared])
  const [pdfOpen, setPdfOpen] = useState(true)
  const revealPdf = useMemo(() => () => setPdfOpen(true), [])

  return (
    <MarkProvider marks={marks} onReveal={revealPdf}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3 lg:order-2 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
          <SectionLabel>Bilaget</SectionLabel>
          {preview ? (
            <PdfPreview
              image={preview}
              marks={marks.filter((m) => m.box.page === preview.page)}
              open={pdfOpen}
              onOpenChange={setPdfOpen}
            />
          ) : (
            <Alert>
              <FileText aria-hidden />
              <AlertTitle>Klarte ikke å vise bilaget</AlertTitle>
              <AlertDescription>
                Tallene er likevel lest. Åpne bilaget i Fiken for å sammenligne.
              </AlertDescription>
            </Alert>
          )}
          <p className="px-1 text-xs text-[var(--color-fg-base)]/50">
            Hvert tall har samme nummer her og i bilaget. Hold over eller trykk på et nummer for å
            se hvor det står.
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:order-1">{children}</div>
      </div>
    </MarkProvider>
  )
}

interface RoundingAction {
  pending: boolean
  error: Error | null
  onBook: () => void
}

/**
 * A month already booked: what is in Fiken against the bilag. Only an øreavrunding can be
 * written from here.
 */
function AuditReview({
  data: { prepared, audit, preview },
  companyName,
  rounding,
}: {
  data: AuditAnalysis
  companyName: string
  rounding: RoundingAction
}) {
  const checks = [...prepared.checks, ...audit.checks]
  const failed = checks.filter((c) => !c.ok).length
  const sides = [
    { side: "sale" as const, vouchers: audit.booked.sales },
    ...(prepared.plan.purchase.lines.length > 0 || audit.booked.purchases.length > 0
      ? [{ side: "purchase" as const, vouchers: audit.booked.purchases }]
      : []),
  ]

  return (
    <ReviewLayout prepared={prepared} preview={preview}>
      <Totals prepared={prepared} blocked={false} failed={failed} />

      <div className="flex flex-col gap-3">
        <SectionLabel>Salg og kjøp i Fiken</SectionLabel>
        {sides.flatMap(({ side, vouchers }) =>
          vouchers.length > 0
            ? vouchers.map((v) => (
                <BookedCard key={`${side}-${v.id}`} side={side} voucher={v} plan={prepared.plan} />
              ))
            : [<BookedCard key={side} side={side} plan={prepared.plan} />],
        )}
      </div>

      {audit.transfers.length > 0 ? (
        <div className="flex flex-col gap-3">
          <SectionLabel
            aside={
              <span className="text-xs text-[var(--color-fg-base)]/60">
                {audit.transfers.filter((t) => t.existing).length} av {audit.transfers.length} ført
              </span>
            }
          >
            Utbetalinger i Fiken
          </SectionLabel>
          {audit.transfers.map((t) => (
            <TransferCard key={t.voucher} transfer={t} audit />
          ))}
        </div>
      ) : null}

      <ChecksCard checks={checks} blockers={[]} subtitle="Føringen i Fiken mot bilaget" />

      {audit.rounding ? (
        <RoundingCard
          correction={audit.rounding}
          othersFailed={checks.filter((c) => !c.ok && !isRoundingCheck(c)).length}
          companyName={companyName}
          action={rounding}
        />
      ) : null}

      <MappingDetails prepared={prepared} />

      <p className="text-xs text-[var(--color-fg-base)]/50">
        {audit.rounding
          ? "Måneden er allerede ført. Øreavrundingen kan føres herfra, andre avvik retter du i Fiken."
          : "Måneden er allerede ført, så her kan du bare kontrollere. Avvik retter du i Fiken."}
      </p>
    </ReviewLayout>
  )
}

/** The fri postering that evens out a month booked with Fiken's VAT, with its own confirm. */
function RoundingCard({
  correction: r,
  othersFailed,
  companyName,
  action,
}: {
  correction: RoundingCorrection
  othersFailed: number
  companyName: string
  action: RoundingAction
}) {
  const [confirming, setConfirming] = useState(false)
  const [override, setOverride] = useState(false)
  const amount = formatNok(Math.abs(r.amount))
  const accountName = (code: string) =>
    code === config.checkinAccount ? "Checkin" : "Øreavrunding"
  const canBook = !action.pending && (othersFailed === 0 || override)

  return (
    <Card
      icon={<Coins />}
      title="Øreavrunding"
      subtitle={`${config.checkinAccount} er ${amount} for ${r.amount < 0 ? "høy" : "lav"}`}
    >
      <p className="mt-3 text-sm text-[var(--color-fg-base)]/80">
        Måneden er ført med netto fra Checkin og mva regnet av Fiken. Checkin regner mva per
        billett, så summen inkl. mva avviker med noen øre. En fri postering retter Checkin-kontoen.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <AccountChip code={r.creditAccount} name={accountName(r.creditAccount)} />
        <ArrowRight className="size-4 shrink-0 text-[var(--color-fg-base)]/50" aria-label="til" />
        <AccountChip code={r.debitAccount} name={accountName(r.debitAccount)} />
        <span className="ml-auto flex flex-col items-end">
          <span className="tabular text-lg leading-snug">{amount}</span>
          <span className="text-xs text-[var(--color-fg-base)]/60">{formatDay(r.date)}</span>
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--color-fg-base)]/50">«{r.description}»</p>

      {othersFailed > 0 ? (
        <div className="mt-4 flex items-start gap-3">
          <Checkbox
            id="rounding-override"
            checked={override}
            onCheckedChange={(v) => setOverride(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="rounding-override" className="font-normal leading-snug">
            Jeg har sett de andre avvikene og vil føre øreavrundingen likevel.
          </Label>
        </div>
      ) : null}

      {action.error ? (
        <Alert variant="destructive" className="mt-4">
          <OctagonX aria-hidden />
          <AlertTitle>Øreavrundingen ble ikke ført</AlertTitle>
          <AlertDescription>
            <p className="select-text break-all">{action.error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Button disabled={!canBook} onClick={() => setConfirming(true)} className="mt-4 w-full">
        {action.pending ? (
          <Spinner className="size-5" />
        ) : (
          <CircleCheck className="size-5" aria-hidden />
        )}
        Før øreavrunding
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bokfør øreavrunding i Fiken?</AlertDialogTitle>
            <AlertDialogDescription>
              En fri postering på {amount} fra {r.creditAccount} til {r.debitAccount} blir bokført{" "}
              {formatDay(r.date)} i {companyName}, med bilaget vedlagt. Bokførte bilag kan bare
              rettes ved å annullere dem i Fiken.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                action.onBook()
              }}
            >
              Bokfør
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function BookedCard({
  side,
  voucher,
  plan,
}: {
  side: "sale" | "purchase"
  voucher?: BookedVoucher
  plan: Prepared["plan"]
}) {
  const name = side === "sale" ? "Salg" : "Kjøp"
  const marks = useMarksFor([
    ...new Set(
      (voucher?.lines ?? []).flatMap((l) => {
        const { net, vat } = bookedLineKeys(config, plan, side, l)
        return [...net, vat]
      }),
    ),
  ])
  return (
    <Card
      marks={marks}
      icon={side === "sale" ? <Landmark /> : <ReceiptText />}
      title={voucher?.number ? `${name} «${voucher.number}»` : name}
      subtitle={
        voucher
          ? [voucher.date && formatDay(voucher.date), `id ${voucher.id}`]
              .filter(Boolean)
              .join(" · ")
          : `Fant ${side === "sale" ? "ikke salget" : "ikke kjøpet"} i Fiken`
      }
      aside={
        voucher ? null : (
          <Badge variant="destructive">
            <CircleX aria-hidden />
            Mangler
          </Badge>
        )
      }
      className={cn(!voucher && "bg-[var(--color-bg-surface)]/50")}
    >
      {voucher ? (
        <>
          <ul className="mt-4 flex flex-col gap-1">
            {voucher.lines.map((l, i) => (
              <BookedLine
                // biome-ignore lint/suspicious/noArrayIndexKey: order is fixed for a booked voucher
                key={i}
                line={l}
                keys={bookedLineKeys(config, plan, side, l)}
              />
            ))}
          </ul>
          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
            <span className="text-sm text-[var(--color-fg-base)]/70">Sum inkl. mva</span>
            <span className="tabular text-xl">{formatNok(voucher.gross)}</span>
          </div>
        </>
      ) : null}
    </Card>
  )
}

function BookedLine({
  line,
  keys,
}: {
  line: BookedVoucher["lines"][number]
  keys: ReturnType<typeof bookedLineKeys>
}) {
  const net = useMarksFor(keys.net)
  const vat = useMarksFor([keys.vat])
  return <LineRow line={line} net={net} vat={vat} />
}

function Totals({
  prepared: { plan },
  blocked,
  failed,
}: {
  prepared: Prepared
  blocked: boolean
  failed: number
}) {
  const items = [
    { label: "Salg", value: plan.sale.gross },
    { label: "Kjøp", value: plan.purchase.gross },
    { label: "Salg − kjøp", value: plan.expectedPayout },
  ]
  return (
    <section className="@container flex flex-col gap-3 rounded-xl bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-fg-base)]/60">Bilagsdato {formatDay(plan.date)}</p>
        <StatusBadge blocked={blocked} failed={failed} />
      </div>
      <dl className="grid gap-x-4 gap-y-2 @xl:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-baseline justify-between gap-3 @xl:flex-col @xl:items-start @xl:gap-0.5"
          >
            <dt className="text-sm text-[var(--color-fg-base)]/60">{item.label}</dt>
            <dd className="tabular text-lg">{formatNok(item.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function StatusBadge({ blocked, failed }: { blocked: boolean; failed: number }) {
  return (
    <Badge variant={failed === 0 && !blocked ? "default" : "destructive"}>
      {blocked ? "Kan ikke føres" : failed === 0 ? "Alt stemmer" : `${failed} avvik`}
    </Badge>
  )
}

const vatLabel = (vatType: string) =>
  vatType === "HIGH"
    ? "25 % mva"
    : vatType === "MEDIUM"
      ? "15 % mva"
      : vatType === "LOW"
        ? "12 % mva"
        : "uten mva"

function SideCard({
  side,
  prepared,
  fiken,
}: {
  side: "sale" | "purchase"
  prepared: Prepared
  fiken: FikenState
}) {
  const { plan, adjusted } = prepared
  const { lines, gross } = plan[side]
  const contact = side === "sale" ? fiken.customer : fiken.supplier
  const notes = adjusted.filter((r) => r.side === side)
  const existing = fiken.existing[side]
  const marks = useMarksFor([
    ...new Set(
      lines.flatMap((l) => [
        ...lineKeys(config, side, l.description),
        l.vat ? vatKey(config, side, l.vatType) : undefined,
      ]),
    ),
  ])

  return (
    <Card
      marks={marks}
      icon={side === "sale" ? <Landmark /> : <ReceiptText />}
      title={side === "sale" ? "Salg" : "Kjøp"}
      subtitle={[
        side === "sale"
          ? `Kontantsalg · betalt til ${config.checkinAccount}`
          : `${contact ? "Leverandørkjøp" : "Kontantkjøp"} · betalt fra ${config.checkinAccount}`,
        contact && `${contact.name}${contact.accountCode ? ` (${contact.accountCode})` : ""}`,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <ul className="mt-4 flex flex-col gap-1">
        {lines.map((l) => (
          <SideLine key={`${l.description}-${l.vatType}`} side={side} line={l} />
        ))}
      </ul>
      {notes.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-[var(--color-fg-base)]/50">
          {notes.map((r) => (
            <li key={r.description}>Øreavrunding: {explainRounding(r)}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
        <span className="text-sm text-[var(--color-fg-base)]/70">Sum inkl. mva</span>
        <MarkedAmount marks={[]} className="text-xl">
          {formatNok(gross)}
        </MarkedAmount>
      </div>
      {existing ? (
        <Badge variant="secondary" className="mt-3 text-[var(--color-fg-base)]/80">
          <CircleCheck aria-hidden />
          {existingText(existing)}
        </Badge>
      ) : null}
    </Card>
  )
}

function SideLine({ side, line }: { side: "sale" | "purchase"; line: OrderLine }) {
  const net = useMarksFor(lineKeys(config, side, line.description))
  const vat = useMarksFor(line.vat ? [vatKey(config, side, line.vatType)] : [])
  return <LineRow line={line} net={net} vat={vat} />
}

/** A line of a sale or purchase. Hovering it emphasises its net and VAT on the PDF. */
function LineRow({
  line,
  net,
  vat,
}: {
  line: { description?: string; account: string; vatType: string; netPrice: number; vat?: number }
  net: Mark[]
  vat: Mark[]
}) {
  return (
    <MarkRow marks={[...net, ...vat]}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-semibold">{line.description ?? "Uten tekst"}</span>
          <span className="block text-sm text-[var(--color-fg-base)]/60">
            Konto {line.account} · {vatLabel(line.vatType)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <MarkedAmount marks={net}>{formatNok(line.netPrice)}</MarkedAmount>
          {line.vat ? (
            <MarkedAmount marks={vat} className="text-sm text-[var(--color-fg-base)]/70">
              mva {formatNok(line.vat)}
            </MarkedAmount>
          ) : null}
        </span>
      </div>
    </MarkRow>
  )
}

/**
 * A payout as a fri postering from the Checkin account to the bank. Same look as the sale and
 * purchase: one in Fiken is a full card with a badge, one missing from a booked month is muted.
 */
function TransferCard({ transfer: t, audit = false }: { transfer: Transfer; audit?: boolean }) {
  const marks = useMarksFor([payoutKey(t.voucher)])
  return (
    <Card
      marks={marks}
      icon={<ArrowRightLeft />}
      title="Utbetaling"
      subtitle={`${formatDay(t.date)} · Checkin-bilag ${t.voucher}`}
      className={cn(audit && !t.existing && "bg-[var(--color-bg-surface)]/50")}
    >
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <AccountChip code={config.checkinAccount} name="Checkin" />
        <ArrowRight className="size-4 shrink-0 text-[var(--color-fg-base)]/50" aria-label="til" />
        <AccountChip code={config.bankAccount} name="Bank" />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
        <span className="text-sm text-[var(--color-fg-base)]/70">Beløp</span>
        <MarkedAmount marks={marks} className="text-xl">
          {formatNok(t.amount)}
        </MarkedAmount>
      </div>

      {t.existing ? (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <Badge variant="secondary" className="text-[var(--color-fg-base)]/80">
            <CircleCheck aria-hidden />
            {audit ? "Ført i Fiken" : "Allerede ført i Fiken"}
          </Badge>
          {t.existing.description ? (
            <p className="text-xs text-[var(--color-fg-base)]/50">
              I Fiken: «{t.existing.description}»
            </p>
          ) : null}
        </div>
      ) : audit ? (
        <Badge variant="destructive" className="mt-3">
          <CircleX aria-hidden />
          Mangler i Fiken
        </Badge>
      ) : (
        <p className="mt-3 text-xs text-[var(--color-fg-base)]/50">«{t.description}»</p>
      )}
    </Card>
  )
}

function AccountChip({ code, name }: { code: string; name: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-lg bg-white/5 px-2.5 py-1">
      <span className="tabular font-semibold">{code}</span>
      <span className="text-[var(--color-fg-base)]/60">{name}</span>
    </span>
  )
}

function ChecksCard({
  checks,
  blockers,
  subtitle = "Tallene i bilaget mot hverandre og mot Checkin-kontoen i Fiken",
}: {
  checks: Check[]
  blockers: string[]
  subtitle?: string
}) {
  const failed = checks.filter((c) => !c.ok).length
  // Deviations first, then passing checks with a note or pinned (the Checkin saldo); these stay
  // in view. The rest fold away.
  const shown = checks.filter((c) => !c.ok || c.note || c.pinned)
  const notes = checks.filter((c) => c.ok && c.note).length
  const figures = checkKeys(config)
  const marks = useMarksFor(figures.map((f) => f.key))
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
        title={
          <>
            {failed === 0 ? "Alt stemmer" : `${failed} av ${checks.length} avviker`}
            {notes > 0 ? (
              <Badge className="ml-2 bg-[var(--color-fg-warning)]/15 align-middle text-[var(--color-fg-warning)]">
                {notes} {notes === 1 ? "merknad" : "merknader"}
              </Badge>
            ) : null}
          </>
        }
        subtitle={subtitle}
      >
        {shown.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-3">
            {[...shown]
              .sort((a, b) => Number(a.ok) - Number(b.ok))
              .map((c) => (
                <CheckRow key={c.label} check={c} />
              ))}
          </ul>
        ) : null}

        {/* Passing checks are detail: folded away so the deviations (or "Alt stemmer") stand out. */}
        {shown.length < checks.length ? (
          <details className="group mt-4 border-t border-white/10 pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-[var(--color-fg-base)]/70 hover:text-[var(--color-fg-base)] [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="size-4 shrink-0 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {shown.length === 0
                ? `Vis de ${checks.length} kontrollene`
                : `Vis de ${checks.length - shown.length} som stemmer`}
            </summary>
            <ul className="mt-3 flex flex-col gap-3">
              {checks
                .filter((c) => !shown.includes(c))
                .map((c) => (
                  <CheckRow key={c.label} check={c} />
                ))}
            </ul>

            {marks.length > 0 ? (
              <div className="mt-4 border-t border-white/10 pt-3">
                <p className="mb-1 text-xs tracking-[0.15em] text-[var(--color-fg-base)]/50 uppercase">
                  Kontrolltall i bilaget
                </p>
                <ul className="flex flex-col text-sm">
                  {marks.map((m) => (
                    <MarkRow key={m.n} marks={[m]} className="py-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[var(--color-fg-base)]/70">Checkin {m.label}</span>
                        <MarkedAmount marks={[m]}>{formatNok(m.amount)}</MarkedAmount>
                      </div>
                    </MarkRow>
                  ))}
                </ul>
              </div>
            ) : null}
          </details>
        ) : null}
      </Card>
    </div>
  )
}

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex gap-3">
      {check.ok && check.note ? (
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-warning)]"
          aria-label="Merknad"
        />
      ) : check.ok ? (
        <CircleCheck
          className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-brand)]"
          aria-label="OK"
        />
      ) : (
        <CircleX
          className="mt-0.5 size-5 shrink-0 text-[var(--color-bg-danger)]"
          aria-label="Avvik"
        />
      )}
      <span className="min-w-0 text-sm">
        <span className="block leading-snug">{check.label}</span>
        <span className="mt-0.5 block text-[var(--color-fg-base)]/60 tabular-nums">
          {check.source ?? "beregnet"} {formatNok(check.expected)} · Checkin{" "}
          {formatNok(check.actual)}
          {!check.ok ? ` · avvik ${formatNok(check.expected - check.actual)}` : ""}
        </span>
        {!check.ok && check.hint ? (
          <span className="mt-1 block text-[var(--color-bg-danger)]">{check.hint}</span>
        ) : null}
        {check.ok && check.note ? (
          <span className="mt-1 block text-[var(--color-fg-warning)]">{check.note}</span>
        ) : null}
      </span>
    </li>
  )
}

function MappingDetails({ prepared }: { prepared: Prepared }) {
  const { byKey } = useMarks()
  return (
    <details className="group rounded-xl bg-[var(--color-bg-surface)]/60 p-4 text-sm sm:p-5">
      <summary className="cursor-pointer font-semibold text-[var(--color-fg-base)]/80">
        Slik er bilaget lest
      </summary>
      <p className="mt-2 text-xs text-[var(--color-fg-base)]/50">
        Netto endring per konto i Checkins bilag, og hvor beløpet føres hos oss. Checkins kontonumre
        brukes ikke i Fiken.
      </p>
      <ul className="mt-3 flex flex-col">
        {prepared.mapping.map((row) => {
          const mark = byKey.get(`result:${row.checkinAccount}`)
          return (
            <MarkRow key={row.checkinAccount} marks={mark ? [mark] : []} className="py-1">
              <div className="flex items-center justify-between gap-3">
                <span>
                  {row.checkinAccount}{" "}
                  <span className="text-[var(--color-fg-base)]/50">
                    {row.target === "ignored"
                      ? "føres ikke"
                      : row.target === "unmapped"
                        ? "mangler i oppskriften"
                        : `→ ${row.target.account} «${row.target.description}»`}
                  </span>
                </span>
                <MarkedAmount marks={mark ? [mark] : []}>{formatNok(row.net)}</MarkedAmount>
              </div>
            </MarkRow>
          )
        })}
      </ul>
    </details>
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
  result?: BookResult
  error: Error | null
  pending: boolean
  onDone: () => void
}) {
  const balanceOk = result?.balance ? result.balance.actual === result.balance.expected : undefined
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>
        {pending
          ? "Fører i Fiken…"
          : error
            ? "Føringen stoppet"
            : mode === "draft"
              ? "Utkastene ligger i Fiken"
              : "Bokført i Fiken"}
      </SectionLabel>
      <section className="rounded-xl bg-[var(--color-bg-surface)] p-4 sm:p-5">
        <ul className="space-y-3">
          {progress.map((s) => (
            <li key={s} className="flex gap-3">
              <CircleCheck
                className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-brand)]"
                aria-hidden
              />
              {s}
            </li>
          ))}
          {result?.balance ? (
            <li className="flex gap-3">
              {balanceOk ? (
                <CircleCheck
                  className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-brand)]"
                  aria-hidden
                />
              ) : (
                <CircleX
                  className="mt-0.5 size-5 shrink-0 text-[var(--color-bg-danger)]"
                  aria-hidden
                />
              )}
              <span>
                Saldo {config.checkinAccount}:{" "}
                <span className="tabular">{formatNok(result.balance.actual)}</span>
                {!balanceOk
                  ? ` (forventet ${formatNok(result.balance.expected)} – sjekk føringene i Fiken)`
                  : ""}
              </span>
            </li>
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

      {mode === "draft" && result && (config.sale.accrual || config.purchase.accrual) ? (
        <Alert>
          <AlertDescription>
            Utkast kan ikke periodiseres herfra. Periodiser linjene når du bokfører utkastene i
            Fiken.
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
