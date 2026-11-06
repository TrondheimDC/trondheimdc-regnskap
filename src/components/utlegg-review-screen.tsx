"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  CircleCheck,
  FilePen,
  FileText,
  OctagonX,
  ReceiptText,
  RefreshCw,
  Shapes,
  TriangleAlert,
  Undo2,
  UserRound,
} from "lucide-react"
import { Fragment, useMemo, useState } from "react"
import { toast } from "sonner"
import { AccountPicker } from "@/components/account-picker"
import { BookConfirmDialog, type BookMode, type BookRun } from "@/components/book-confirm-dialog"
import { ChoicePicker } from "@/components/choice-picker"
import { BookedTotal, ChecksCard } from "@/components/hotel-review-screen"
import { MarkedAmount, MarkProvider, MarkRow, useMarksFor } from "@/components/marks"
import { PagedPdfPreview } from "@/components/pdf-preview"
import { Card, SectionLabel, StatusBadge } from "@/components/review-screen"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { config } from "@/lib/app-config"
import type { UtleggConfig, VatRate } from "@/lib/config"
import type { Fiken, InboxDocument } from "@/lib/fiken"
import { formatDay } from "@/lib/format"
import { RATE_LABEL } from "@/lib/hotel"
import { buildUtleggMarks } from "@/lib/marks"
import { pdfPageCount, renderPdfPage } from "@/lib/pdf-render"
import { formatMoney, formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"
import { parseUtleggPdf, type UtleggPlacement, type UtleggPlan } from "@/lib/utlegg"
import {
  bookUtlegg,
  describeUpdate,
  inspectUtlegg,
  prepareUtlegg,
  type UtleggFikenState,
  type UtleggPrepared,
  type UtleggSource,
  utleggBlockers,
} from "@/lib/utlegg-booking"

export type UtleggSelection = { kind: "utlegg"; doc: InboxDocument } | { kind: "file"; file: File }

async function analyze(client: Fiken, utlegg: UtleggConfig, selection: UtleggSelection) {
  const pdf =
    selection.kind === "utlegg"
      ? await client.downloadInboxDocument(selection.doc)
      : new Uint8Array(await selection.file.arrayBuffer())
  const source: UtleggSource = {
    report: await parseUtleggPdf(pdf),
    doc: selection.kind === "utlegg" ? selection.doc : undefined,
    description:
      selection.kind === "utlegg" ? `Innboks ${selection.doc.documentId}` : selection.file.name,
  }
  // Reference and date don't depend on the choices, so Fiken is asked once.
  const plan = prepareUtlegg(source, utlegg).plan
  const [fiken, preview, pageCount] = await Promise.all([
    inspectUtlegg(client, source, plan, { attach: true }),
    renderPdfPage(pdf, 0).catch(() => undefined),
    pdfPageCount(pdf).catch(() => 1),
  ])
  return { source, fiken, pdf, preview, pageCount }
}

type Analysis = Awaited<ReturnType<typeof analyze>>

const utleggRecipe = () => {
  if (!config.utlegg) throw new Error("Oppskriften har ingen utlegg")
  return config.utlegg
}

interface Choices {
  moves: Record<string, string>
  rates: Record<string, VatRate>
  accounts: Record<string, string>
}

const NO_CHOICES: Choices = { moves: {}, rates: {}, accounts: {} }

export function UtleggReviewScreen({
  client,
  companyName,
  selection,
  onBack,
}: {
  client: Fiken
  companyName: string
  selection: UtleggSelection
  onBack: () => void
}) {
  const utlegg = utleggRecipe()
  const queryClient = useQueryClient()
  const key =
    selection.kind === "utlegg"
      ? `doc-${selection.doc.documentId}`
      : `file-${selection.file.name}-${selection.file.size}-${selection.file.lastModified}`
  const analysisKey = ["utlegg-analysis", client.companySlug, key]
  const analysis = useQuery({
    queryKey: analysisKey,
    queryFn: () => analyze(client, utlegg, selection),
  })

  const [choices, setChoices] = useState<Choices>(NO_CHOICES)
  const [override, setOverride] = useState(false)
  // What the user confirmed, kept as it was while the screen behind the dialog updates.
  const [confirming, setConfirming] = useState<Confirming>()
  const [progress, setProgress] = useState<string[]>([])

  const source = analysis.data?.source
  const prepared = useMemo(
    () => source && prepareUtlegg(source, utlegg, choices),
    [source, utlegg, choices],
  )

  // After writing: Fiken as it is now goes into this report's cache, so the screen, and opening
  // the report again, shows the purchase. Only Fiken is read again, not the PDF.
  const reread = async ({ source, plan }: UtleggPrepared) => {
    try {
      const fiken = await inspectUtlegg(client, source, plan, { attach: true })
      queryClient.setQueryData<Analysis>(analysisKey, (old) => old && { ...old, fiken })
    } catch {
      await queryClient.invalidateQueries({ queryKey: analysisKey, refetchType: "none" })
    }
    void queryClient.invalidateQueries({
      queryKey: ["utlegg-docs", client.companySlug],
      refetchType: "all",
    })
  }

  const booking = useMutation({
    mutationFn: async ({ mode, prepared, fiken }: Confirming) => {
      setProgress([])
      try {
        return await bookUtlegg(client, prepared, fiken, mode, (step) =>
          setProgress((p) => [...p, step]),
        )
      } finally {
        // Also after a failure: what got written is in Fiken.
        await reread(prepared)
      }
    },
  })
  const closeBooking = () => {
    setConfirming(undefined)
    booking.reset()
  }

  const report = source?.report
  const title = report?.name ? `Utlegg fra ${report.name}` : "Utlegg"
  const docName = selection.kind === "utlegg" ? selection.doc.name : selection.file.name
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
          {booking.isPending ? null : (
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
          {selection.kind === "file" ? <Badge variant="outline">Lokal fil</Badge> : null}
        </p>
      </header>

      {analysis.isPending ? (
        <div
          className="flex min-h-[60svh] flex-col items-center justify-center gap-3 rounded-xl bg-[var(--color-bg-surface)]/50 text-sm text-[var(--color-fg-base)]/70"
          aria-busy="true"
        >
          <Spinner className="size-6" />
          Leser utleggsrapporten og sjekker Fiken…
        </div>
      ) : null}

      {analysis.isError ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>
            {analysis.data ? "Klarte ikke å oppdatere fra Fiken" : "Klarte ikke å lese rapporten"}
          </AlertTitle>
          <AlertDescription>{analysis.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {analysis.data && prepared ? (
        <UtleggReview
          utlegg={utlegg}
          data={analysis.data}
          prepared={prepared}
          choices={choices}
          onChoices={setChoices}
          override={override}
          onOverride={setOverride}
          onBook={(mode) =>
            analysis.data && setConfirming({ mode, prepared, fiken: analysis.data.fiken })
          }
          disabled={booking.isPending}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          confirming={confirming}
          companyName={companyName}
          run={
            booking.isIdle
              ? undefined
              : {
                  progress,
                  pending: booking.isPending,
                  error: booking.error,
                  result: booking.data ? <BookedTotal result={booking.data} /> : null,
                }
          }
          onCancel={closeBooking}
          onConfirm={() => booking.mutate(confirming)}
        />
      ) : null}
    </main>
  )
}

interface Confirming {
  mode: BookMode
  prepared: UtleggPrepared
  fiken: UtleggFikenState
}

function ConfirmDialog({
  confirming: {
    mode,
    prepared: { plan, source },
    fiken,
  },
  companyName,
  run,
  onCancel,
  onConfirm,
}: {
  confirming: Confirming
  companyName: string
  run?: BookRun
  onCancel: () => void
  onConfirm: () => void
}) {
  const person = fiken.person
  return (
    <BookConfirmDialog
      mode={mode}
      title={{ draft: "Lag kjøpsutkast i Fiken?", create: "Bokfør i Fiken?" }}
      done={{ draft: "Kjøpsutkastet ligger i Fiken", create: "Bokført i Fiken" }}
      subtitle={`${plan.reference} · ${companyName}`}
      items={[
        {
          icon: <ReceiptText />,
          label: `Kjøp fra ${source.report.name}`,
          detail: `${plan.lines.length} kvitteringer · forfall ${formatDay(plan.dueDate)}`,
          amount: plan.gross,
          currency: plan.currency,
        },
      ]}
      notes={[
        person?.status === "new" &&
          `${person.contact.name} legges inn som leverandør${person.contact.bankAccountNumber ? ` med konto ${person.contact.bankAccountNumber}` : ""}.`,
        person?.status === "found" &&
          person.update &&
          `${describeUpdate(person.update)} legges inn på ${person.contact.name} i Fiken.`,
        "Utleggsrapporten legges ved.",
        "Står som ubetalt gjeld til personen til økonomiansvarlig betaler den fra Fiken.",
        plan.currency !== "NOK" &&
          `Kjøpet føres i ${plan.currency}; Fiken regner det om til NOK. IBAN og BIC står i utleggsrapporten.`,
        mode === "create" && "Bokførte bilag kan bare rettes ved å annullere dem i Fiken.",
      ]}
      run={run}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

function UtleggReview({
  utlegg,
  data: { fiken, pdf, preview, pageCount, source },
  prepared,
  choices,
  onChoices,
  override,
  onOverride,
  onBook,
  disabled,
}: {
  utlegg: UtleggConfig
  data: Analysis
  prepared: UtleggPrepared
  choices: Choices
  onChoices: (c: Choices) => void
  override: boolean
  onOverride: (v: boolean) => void
  onBook: (mode: BookMode) => void
  disabled: boolean
}) {
  const { plan, checks } = prepared
  const blockers = utleggBlockers(prepared, fiken)
  const failed = checks.filter((c) => !c.ok).length
  const blocked = blockers.length > 0
  const canBook = !blocked && (failed === 0 || override) && !disabled
  const marks = useMemo(() => buildUtleggMarks(source.report), [source.report])
  const [pdfOpen, setPdfOpen] = useState(true)
  const [page, setPage] = useState(0)
  const showPage = (p: number) => {
    setPdfOpen(true)
    setPage(p)
  }
  const revealPdf = useMemo(
    () => (n: number) => {
      setPdfOpen(true)
      const mark = marks.find((m) => m.n === n)
      if (mark) setPage(mark.box.page)
    },
    [marks],
  )
  const changed = Object.keys(choices.moves).length + Object.keys(choices.rates).length

  return (
    <MarkProvider marks={marks} onReveal={revealPdf}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3 lg:order-2 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
          <SectionLabel>Utleggsrapporten</SectionLabel>
          {preview ? (
            <PagedPdfPreview
              pdf={pdf}
              first={preview}
              count={pageCount}
              page={page}
              onPage={setPage}
              marks={marks}
              open={pdfOpen}
              onOpenChange={setPdfOpen}
              title="Utleggsrapporten"
            />
          ) : (
            <Alert>
              <FileText aria-hidden />
              <AlertTitle>Klarte ikke å vise rapporten</AlertTitle>
              <AlertDescription>
                Tallene er likevel lest. Åpne rapporten i Fiken for å sammenligne.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:order-1">
          <Totals prepared={prepared} blocked={blocked} failed={failed} />

          <div className="flex flex-col gap-3">
            <SectionLabel>Personen</SectionLabel>
            <PersonCard prepared={prepared} fiken={fiken} />
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel
              aside={
                changed > 0 ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onChoices({ ...choices, moves: {}, rates: {} })}
                    className="text-[var(--color-fg-base)]/70"
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                    Tilbakestill {changed} {changed === 1 ? "endring" : "endringer"}
                  </Button>
                ) : null
              }
            >
              Kvitteringene
            </SectionLabel>
            <p className="-mt-1 text-xs text-[var(--color-fg-base)]/50">
              {source.report.format === 2
                ? "Kategorien er den personen valgte i skjemaet."
                : "Oppskriften foreslår kategori ut fra beskrivelsen."}{" "}
              Flytt en kvittering hvis den hører hjemme et annet sted. Mva-satsen leses fra
              kvitteringen når den har tekst, ellers settes den etter kategori.
            </p>
            <ul className="flex flex-col gap-3">
              {plan.placements.map((p) => (
                <ReceiptRow
                  key={p.row.n}
                  utlegg={utlegg}
                  placement={p}
                  plan={plan}
                  onCategory={(c) =>
                    onChoices({ ...choices, moves: { ...choices.moves, [`#${p.row.n}`]: c } })
                  }
                  onRate={(r) =>
                    onChoices({ ...choices, rates: { ...choices.rates, [`#${p.row.n}`]: r } })
                  }
                  onShow={
                    p.row.pages[0] !== undefined ? () => showPage(p.row.pages[0]!) : undefined
                  }
                />
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>Kontoer</SectionLabel>
            <AccountsCard
              utlegg={utlegg}
              plan={plan}
              fiken={fiken}
              accounts={choices.accounts}
              onAccount={(category, account) =>
                onChoices({ ...choices, accounts: { ...choices.accounts, [category]: account } })
              }
            />
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>Kjøpet</SectionLabel>
            <PurchaseCard plan={plan} name={source.report.name} />
          </div>

          <ChecksCard
            checks={checks}
            blockers={blockers}
            subtitle="Kvitteringene mot totalen, mva-satsene og datoene"
          />

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
                «Lag utkast» legger kjøpet i Fiken uten å bokføre. «Bokfør» fører det som ubetalt
                gjeld til personen, klart for utbetaling fra Fiken.
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
  prepared: UtleggPrepared
  blocked: boolean
  failed: number
}) {
  const { report } = source
  const items = [
    { label: "Dato (siste kvittering)", value: plan.date ? formatDay(plan.date) : "–" },
    { label: "Forfall", value: formatDay(plan.dueDate) },
    {
      label: "Total",
      value: report.total !== undefined ? formatMoney(report.total, plan.currency) : "–",
    },
  ]
  return (
    <section className="@container flex flex-col gap-3 rounded-xl bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-fg-base)]/60">
          {report.rows.length} kvitteringer
          {report.generated ? ` · sendt ${formatDay(report.generated)}` : ""}
          {report.reportId ? ` · ${report.reportId}` : ""}
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

function PersonCard({ prepared, fiken }: { prepared: UtleggPrepared; fiken: UtleggFikenState }) {
  const { report } = prepared.source
  const person = fiken.person
  const account = report.bankAccount ?? report.iban
  const found = person?.status === "found" ? person : undefined
  // What the report says next to what Fiken has, so a gap in Fiken isn't read as a parsing error.
  const rows = [
    {
      label: "E-post",
      report: report.email,
      fiken: found ? found.contact.email : undefined,
      fills: found?.update?.email !== undefined,
    },
    {
      label: "Konto",
      report: account,
      // Fiken stores only Norwegian account numbers on a contact; an IBAN stays in the report.
      fiken: report.iban
        ? "lagres ikke (IBAN)"
        : found
          ? found.contact.bankAccountNumber
          : undefined,
      fills: found?.update?.bankAccountNumber !== undefined,
    },
  ]
  return (
    <Card
      icon={<UserRound />}
      title={report.name || "Ukjent navn"}
      subtitle={`Utbetaling i ${report.payoutCurrency}`}
      aside={
        person?.status === "new" ? (
          <Badge>Ny leverandør</Badge>
        ) : person ? (
          <Badge variant="outline">{person.contact.supplierAccountCode ?? "I Fiken"}</Badge>
        ) : null
      }
    >
      {found ? (
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <span />
          <span className="text-xs text-[var(--color-fg-base)]/50">I rapporten</span>
          <span className="text-xs text-[var(--color-fg-base)]/50">I Fiken</span>
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt className="text-[var(--color-fg-base)]/60">{r.label}</dt>
              <dd className="truncate tabular-nums">{r.report ?? "–"}</dd>
              <dd
                className={cn(
                  "truncate tabular-nums",
                  !r.fiken && "text-[var(--color-fg-base)]/60",
                )}
              >
                {r.fiken ?? (r.fills ? "mangler, legges inn" : "mangler")}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <p className="mt-3 text-sm text-[var(--color-fg-base)]/70">
        {person?.status === "new"
          ? "Finnes ikke i Fiken. Legges inn som leverandør med e-post og kontonummer når du fører."
          : found
            ? `Funnet i Fiken på ${found.by === "email" ? "e-post" : "navn"}: kontakt ${found.contact.contactId}.${
                found.update
                  ? ` ${describeUpdate(found.update)} legges inn på kontakten når du fører.`
                  : ""
              }`
            : "Kan ikke avgjøre hvem i Fiken dette er; se kontrollene."}
      </p>
      {fiken.notes.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {fiken.notes.map((n) => (
            <li key={n} className="flex gap-2 text-sm">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-warning)]"
                aria-hidden
              />
              {n}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

const RATE_BY: Record<NonNullable<UtleggPlacement["rateBy"]>, string> = {
  choice: "valgt",
  receipt: "fra kvitteringen",
  currency: "utenlandsk kvittering",
  category: "etter kategori, sjekk kvitteringen",
}

const RATES: VatRate[] = [25, 15, 12, 0]

function ReceiptRow({
  utlegg,
  placement: p,
  plan,
  onCategory,
  onRate,
  onShow,
}: {
  utlegg: UtleggConfig
  placement: UtleggPlacement
  plan: UtleggPlan
  onCategory: (category: string) => void
  onRate: (rate: VatRate) => void
  onShow?: () => void
}) {
  const marks = useMarksFor([`row:${p.row.n}`])
  const line = plan.lines.find((l) => l.n === p.row.n)
  const unplaced = !line
  const guessed = p.rateBy === "category" && line?.deduct
  return (
    <li>
      <Card
        icon={unplaced ? <TriangleAlert /> : <ReceiptText />}
        title={
          <span>
            <span className="text-[var(--color-fg-base)]/50 tabular-nums">#{p.row.n}</span>{" "}
            {p.row.description}
          </span>
        }
        subtitle={[
          p.row.date && formatDay(p.row.date),
          p.row.original &&
            `${formatNok(p.row.original.amount).replace(" kr", "")} ${p.row.original.currency}`,
          p.row.receiptHasText ? "kvittering med tekst" : "bilde av kvittering",
        ]
          .filter(Boolean)
          .join(" · ")}
        aside={
          <MarkedAmount marks={marks} className="shrink-0 pt-0.5 text-lg">
            {p.row.amount === undefined ? "—" : formatMoney(p.row.amount, plan.currency)}
          </MarkedAmount>
        }
        marks={marks}
        className={cn(unplaced && "ring-1 ring-[var(--color-bg-danger)]")}
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ChoicePicker
            label={`Kategori for kvittering ${p.row.n}`}
            value={p.category}
            choices={utlegg.categories.map((c) => ({
              value: c.id,
              label: c.label,
              hint: `Konto ${c.account}`,
            }))}
            placeholder="Velg kategori"
            onChange={onCategory}
            className="w-[14rem]"
          />
          <ChoicePicker
            label={`Mva-sats for kvittering ${p.row.n}`}
            value={p.rate}
            choices={RATES.map((r) => ({ value: r, label: RATE_LABEL(r) }))}
            placeholder="Velg mva-sats"
            invalid={guessed}
            onChange={onRate}
            className="w-[9rem]"
          />
          {onShow ? (
            <Button variant="ghost" size="xs" onClick={onShow}>
              <FileText className="size-3.5" aria-hidden />
              Vis kvittering
            </Button>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-2 text-xs text-[var(--color-fg-base)]/60",
            guessed && "text-[var(--color-fg-warning)]",
          )}
        >
          {[
            p.rateBy && `Mva ${RATE_BY[p.rateBy]}`,
            line && (line.deduct ? "fradrag" : line.rate === 0 ? "" : "uten fradrag"),
            p.row.receiptRates.length > 1 &&
              `kvitteringen nevner ${p.row.receiptRates.map((r) => `${r} %`).join(" og ")}`,
            p.by === "form" && "kategori valgt i skjemaet",
            p.by === "moved" && "flyttet",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Card>
    </li>
  )
}

function AccountsCard({
  utlegg,
  plan,
  fiken,
  accounts,
  onAccount,
}: {
  utlegg: UtleggConfig
  plan: UtleggPlan
  fiken: UtleggFikenState
  accounts: Record<string, string>
  onAccount: (category: string, account: string) => void
}) {
  const used = utlegg.categories.filter((c) => plan.lines.some((l) => l.category === c.id))
  return (
    <Card
      icon={<Shapes />}
      title="Kategoriene i kravet"
      subtitle={used.length === 0 ? "Ingen kvitteringer har kategori ennå" : "Konto per kategori"}
    >
      <ul className="mt-3 flex flex-col gap-2">
        {used.map((c) => {
          const sum = plan.lines.filter((l) => l.category === c.id).reduce((s, l) => s + l.gross, 0)
          return (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
            >
              <label htmlFor={`account-${c.id}`} className="min-w-0 text-sm">
                <span className="font-semibold">{c.label}</span>{" "}
                <span className="tabular text-[var(--color-fg-base)]/60">
                  {formatMoney(sum, plan.currency)}
                </span>
              </label>
              <AccountPicker
                id={`account-${c.id}`}
                value={accounts[c.id] ?? c.account}
                suggested={c.account}
                accounts={fiken.accounts}
                onChange={(a) => onAccount(c.id, a)}
              />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function PurchaseCard({ plan, name }: { plan: UtleggPlan; name: string }) {
  const total = useMarksFor(["total"])
  return (
    <Card
      icon={<ReceiptText />}
      title="Leverandørkjøp"
      subtitle={`Ikke betalt · ${name} · referanse ${plan.reference}`}
    >
      <ul className="mt-4 flex flex-col gap-1">
        {plan.lines.map((l) => (
          <PurchaseLine key={l.n} line={l} currency={plan.currency} />
        ))}
      </ul>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
        <span className="text-sm text-[var(--color-fg-base)]/70">Sum inkl. mva</span>
        <MarkedAmount marks={total} className="text-xl">
          {formatMoney(plan.gross, plan.currency)}
        </MarkedAmount>
      </div>
    </Card>
  )
}

function PurchaseLine({
  line: l,
  currency,
}: {
  line: UtleggPlan["lines"][number]
  currency: string
}) {
  const marks = useMarksFor([`row:${l.n}`])
  return (
    <MarkRow marks={marks} className="py-1.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-semibold">{l.description}</span>
          <span className="block text-sm text-[var(--color-fg-base)]/60">
            Konto {l.account} ·{" "}
            {l.rate === 0
              ? "uten mva"
              : `${RATE_LABEL(l.rate)}, ${l.deduct ? "fradrag" : "uten fradrag"}`}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <MarkedAmount marks={[]}>{formatMoney(l.netPrice, currency)}</MarkedAmount>
          {l.vat ? (
            <MarkedAmount marks={[]} className="text-sm text-[var(--color-fg-base)]/70">
              mva {formatMoney(l.vat, currency)}
            </MarkedAmount>
          ) : null}
        </span>
      </div>
    </MarkRow>
  )
}
