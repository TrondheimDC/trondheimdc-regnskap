// The monthly flow, shared by the CLI and the web app:
//   prepare()      read report -> recipe lines -> checks against the report itself (offline)
//   inspectFiken() read-only checks against Fiken: accounts, attachment, what is already there,
//                  reconciliation
//   book()         create drafts or the real sale + purchase + a fri postering per payout (the
//                  parts chosen, never one already in Fiken), attach the PDF, accrue
//   auditBooked()  for a month already booked: what is in Fiken against the report (read-only)
//   bookRounding() for such a month booked with Fiken's VAT: a fri postering for the øreavrunding
// Nothing here prints or prompts; callers present the results and ask for confirmation.

import type { Movements, ParsedReport } from "./checkin.ts"
import { monthFromText, toReport } from "./checkin.ts"
import type { Config, ContactRef } from "./config.ts"
import type {
  Company,
  Contact,
  DraftRequest,
  Fiken,
  InboxDocument,
  JournalEntry,
  OrderLine,
  PurchaseResult,
  ResultLine,
  SaleResult,
} from "./fiken.ts"
import {
  buildPlan,
  formatMonthNo,
  formatNok,
  lastDayOfMonth,
  lastDayOfPreviousMonth,
  type Plan,
  parseMonth,
} from "./plan.ts"
import {
  applyCheckinVat,
  type BookedLine,
  type Check,
  type FikenCheckinAccount,
  type Rounding,
  type RoundingCorrection,
  reconcile,
  reconcileBooked,
  roundingCorrection,
  roundingDrift,
  roundingLineText,
  verifyBooked,
  verifyNet,
  verifyPayoutList,
  verifyPlan,
  verifyRounding,
  verifyTransfersBooked,
} from "./verify.ts"

export type Mode = "dry-run" | "draft" | "create"

/** The three things a month consists of. Each can be booked on its own. */
export const PARTS = ["sale", "purchase", "transfers"] as const
export type Part = (typeof PARTS)[number]
export type Parts = Record<Part, boolean>

export interface ReportSource extends ParsedReport {
  /** The inbox document the numbers came from, if any. */
  doc?: InboxDocument
  /** Human-readable origin, e.g. a file name or "Fiken-innboks 123". */
  description: string
}

/** One amount read from the report and where the recipe puts it. */
export interface MappingRow {
  checkinAccount: string
  net: number
  target:
    | { side: "sale" | "purchase"; account: string; description: string }
    | "ignored"
    | "unmapped"
}

/**
 * One payout from Checkin to our bank, booked as a fri postering: debit the bank account,
 * credit the Checkin account. This is what the bank line is reconciled against.
 */
export interface Transfer {
  /** Checkin's payout voucher, e.g. "17342:13". */
  voucher: string
  /** "Bokført" date in Checkin's payout overview. */
  date: string
  amount: number
  description: string
  /** Already in Fiken (booked earlier, or a superføring from the bank), so it is skipped. */
  existing?: { journalEntryId: number; description?: string }
}

export interface Prepared {
  month: string
  /** Sale number / purchase identifier, used to detect duplicates. */
  reference: string
  source: ReportSource
  mapping: MappingRow[]
  /** Lines as booked (with Checkin's VAT when enabled). */
  plan: Plan
  /** Fri posteringer moving each payout from the Checkin account to the bank. */
  transfers: Transfer[]
  /** Lines where net and VAT are a few øre off Checkin's (same gross), see `Rounding`. */
  adjusted: Rounding[]
  /** Checks against the report itself. */
  checks: Check[]
}

export interface ContactInfo {
  contactId: number
  name: string
  /** The contact's ledger (reskontro), e.g. 1500:10003 or 2400:20003. */
  accountCode?: string
}

/** Looks up a configured contact and checks it has the right role. Returns a blocker message on failure. */
async function resolveContact(
  client: Fiken,
  ref: ContactRef,
  role: "customer" | "supplier",
): Promise<ContactInfo | string> {
  const label = role === "customer" ? "Kunden" : "Leverandøren"
  let contact: Contact | undefined
  if (ref.contactId !== undefined) {
    contact = await client.getContact(ref.contactId).catch(() => undefined)
  } else {
    const matches = (await client.contacts({ organizationNumber: ref.organizationNumber })).filter(
      (c) => c[role] && !c.inactive,
    )
    if (matches.length > 1) {
      return `${label} med org.nr. ${ref.organizationNumber} finnes ${matches.length} ganger i Fiken. Velg én med contactId i oppskriften (${matches.map((c) => `${c.contactId} ${c.name}`).join(", ")})`
    }
    contact = matches[0]
  }
  const what =
    ref.contactId !== undefined ? `kontakt ${ref.contactId}` : `org.nr. ${ref.organizationNumber}`
  if (!contact) return `${label} (${what}) finnes ikke i Fiken`
  if (!contact[role])
    return `${contact.name} (${what}) er ikke registrert som ${role === "customer" ? "kunde" : "leverandør"} i Fiken`
  if (contact.inactive) return `${contact.name} (${what}) er deaktivert i Fiken`
  const accountCode =
    (role === "customer" ? contact.customerAccountCode : contact.supplierAccountCode) ?? undefined
  return { contactId: contact.contactId, name: contact.name, accountCode }
}

export interface FikenState {
  company: { name: string; slug: string; testCompany?: boolean }
  /** Attachment for the sale and purchase, unless attaching is turned off. */
  doc?: InboxDocument
  /** Checkin as customer on the sale / supplier on the purchase, if configured. */
  customer?: ContactInfo
  supplier?: ContactInfo
  /** Reasons booking is impossible (missing accounts, nothing left to book). */
  blockers: string[]
  /** Sale and purchase for the month already in Fiken. They are not booked again. */
  existing: { sale?: Existing; purchase?: Existing }
  /** The payouts, with the ones already in Fiken marked `existing`. */
  transfers: Transfer[]
  checkin: FikenCheckinAccount
  /** Reconciliation of our Checkin account against the report. */
  checks: Check[]
}

/** A sale or purchase already in Fiken: booked (by us or by hand), or as a draft. */
export type Existing =
  | { status: "booked"; vouchers: BookedVoucher[] }
  | { status: "draft"; draftId: number }

/** What is left to book: a part already in Fiken, or with nothing in it, is not. */
export function bookable(prepared: Prepared, fiken: FikenState): Parts {
  return {
    sale: !fiken.existing.sale,
    purchase: prepared.plan.purchase.lines.length > 0 && !fiken.existing.purchase,
    transfers: fiken.transfers.some((t) => !t.existing),
  }
}

export function mappingRows(movements: Movements, config: Config): MappingRow[] {
  return [...movements]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([checkinAccount, net]) => {
      const sale = config.sale.lines.find((l) => l.from.includes(checkinAccount))
      const purchase = config.purchase.lines.find((l) => l.from.includes(checkinAccount))
      const target: MappingRow["target"] = sale
        ? { side: "sale", account: config.sale.account, description: sale.description }
        : purchase
          ? {
              side: "purchase",
              account: config.purchase.account,
              description: purchase.description,
            }
          : config.ignore.includes(checkinAccount)
            ? "ignored"
            : "unmapped"
      return { checkinAccount, net, target }
    })
}

/** Offline part: recipe lines and checks against the report. Throws if the month is unknown or amounts are unmapped. */
export function prepare(source: ReportSource, config: Config, month = source.month): Prepared {
  if (!month) throw new Error("Fant ikke måneden i bilaget. Oppgi måned (ÅÅÅÅ-MM)")
  if (source.month && month !== source.month) {
    throw new Error(`Valgt måned ${month} stemmer ikke med bilaget (${source.month})`)
  }
  parseMonth(month)

  // Fiken derives the VAT from the gross; we send Checkin's gross so the Checkin account matches
  // Checkin to the øre, and check the resulting VAT against Checkin's.
  const computed = buildPlan(toReport(month, source.movements, config), config)
  const { plan, adjusted } = config.reconcile.useCheckinVat
    ? applyCheckinVat(computed, source.balance, config.reconcile)
    : { plan: computed, adjusted: [] }
  const vatChecks = verifyPlan(plan, source.balance, config.reconcile)

  return {
    month,
    reference: `Checkin ${month}`,
    source,
    mapping: mappingRows(source.movements, config),
    plan,
    transfers: source.payouts.map((p) => ({
      voucher: p.voucher,
      date: p.date,
      amount: p.amount,
      description: `${formatMonthNo(month)} Innbetaling fra Checkin (bilag ${p.voucher})`,
    })),
    adjusted,
    checks: [
      ...vatChecks,
      ...verifyPayoutList(source, config.reconcile.payoutAccounts),
      ...verifyNet(plan, source.balance, config.reconcile),
    ],
  }
}

/** Candidates for the monthly report in the inbox; `match` is set when exactly one fits. */
export async function findReportDocument(
  client: Fiken,
  nameFilter: string,
  month?: string,
): Promise<{ match?: InboxDocument; candidates: InboxDocument[] }> {
  const candidates = await client.inbox({ status: "unused", name: nameFilter })
  // A document that names another month must never be attached; one without a month in its
  // name is only accepted when nothing names the right month.
  const monthOf = (d: InboxDocument) =>
    monthFromText(`${d.name} ${d.filename} ${d.description ?? ""}`)
  const exact = month ? candidates.filter((d) => monthOf(d) === month) : []
  const matches =
    exact.length > 0 ? exact : candidates.filter((d) => !month || monthOf(d) === undefined)
  return { match: matches.length === 1 ? matches[0] : undefined, candidates }
}

/** A monthly report in the inbox, used (attached to something in Fiken) or not. */
export interface ReportDocument extends InboxDocument {
  /** "YYYY-MM" from the document's name, filename or description, if found. */
  month?: string
  /** Fiken has attached it to something, i.e. it has most likely been booked. */
  used: boolean
}

/** All monthly reports in the inbox, used and unused, newest month first. */
export async function listReportDocuments(
  client: Fiken,
  nameFilter: string,
): Promise<ReportDocument[]> {
  const docs = await client.inbox({ status: "all", name: nameFilter })
  return docs
    .map((d) => ({
      ...d,
      month: monthFromText(`${d.name} ${d.filename} ${d.description ?? ""}`),
      used: d.status,
    }))
    .sort(
      (a, b) =>
        (b.month ?? "").localeCompare(a.month ?? "") || b.createdAt.localeCompare(a.createdAt),
    )
}

/** Read-only checks against Fiken. Never writes. */
export async function inspectFiken(
  client: Fiken,
  config: Config,
  prepared: Prepared,
  options: { attach: boolean },
): Promise<FikenState> {
  const { month, plan, reference } = prepared
  const blockers: string[] = []

  const company = await client.getCompany()
  const codes = new Set(
    (await client.bankAccounts()).filter((a) => !a.inactive).map((a) => a.accountCode),
  )
  for (const code of [config.checkinAccount, config.bankAccount]) {
    if (!codes.has(code))
      blockers.push(`Bankkontoen ${code} finnes ikke i Fiken (finnes: ${[...codes].join(", ")})`)
  }

  let doc: InboxDocument | undefined
  if (options.attach) {
    doc =
      prepared.source.doc ??
      (await findReportDocument(client, config.inbox.reportName, month)).match
    if (!doc)
      blockers.push(
        `Fant ikke nøyaktig ett «${config.inbox.reportName}» for måneden i innboksen, så bilaget kan ikke legges ved`,
      )
  }

  // A part is in Fiken if it is booked or lies as a draft; either way it is not booked again.
  const booked = await findBooked(client, config, prepared)
  const saleDraft = (await client.saleDrafts()).find((d) => d.invoiceNumber === reference)
  const purchaseDraft =
    plan.purchase.lines.length > 0
      ? (await client.purchaseDrafts()).find((d) => d.invoiceNumber === reference)
      : undefined
  const existingOf = (
    vouchers: BookedVoucher[],
    draft?: { draftId: number },
  ): Existing | undefined =>
    vouchers.length > 0
      ? { status: "booked", vouchers }
      : draft
        ? { status: "draft", draftId: draft.draftId }
        : undefined
  const existing = {
    sale: existingOf(booked.sales, saleDraft),
    purchase: existingOf(booked.purchases, purchaseDraft),
  }

  let customer: ContactInfo | undefined
  let supplier: ContactInfo | undefined
  if (config.sale.customer) {
    const result = await resolveContact(client, config.sale.customer, "customer")
    if (typeof result === "string") blockers.push(result)
    else customer = result
  }
  if (config.purchase.supplier && plan.purchase.lines.length > 0) {
    const result = await resolveContact(client, config.purchase.supplier, "supplier")
    if (typeof result === "string") blockers.push(result)
    else supplier = result
  }

  const transfers = await findExistingTransfers(client, config, prepared.transfers)

  const checkin: FikenCheckinAccount = {
    code: config.checkinAccount,
    start: await client.accountBalance(config.checkinAccount, lastDayOfPreviousMonth(month)),
    end: await client.accountBalance(config.checkinAccount, plan.date),
  }
  const newTransfers = transfers.filter((t) => !t.existing).reduce((s, t) => s + t.amount, 0)
  const bookedGross = (e?: Existing) =>
    e?.status === "booked" ? e.vouchers.reduce((s, v) => s + v.gross, 0) : undefined

  const state: FikenState = {
    company,
    doc,
    customer,
    supplier,
    blockers,
    existing,
    transfers,
    checkin,
    checks: reconcile(plan, prepared.source, checkin, config.reconcile, newTransfers, {
      sale: bookedGross(existing.sale),
      purchase: bookedGross(existing.purchase),
    }),
  }
  if (!Object.values(bookable(prepared, state)).some(Boolean))
    blockers.push(`Alt i bilaget for ${formatMonthNo(month)} ligger allerede i Fiken`)
  return state
}

/** Days around Checkin's "Bokført" date in which the money may have been booked in Fiken. */
const TRANSFER_WINDOW_BEFORE = 3
const TRANSFER_WINDOW_AFTER = 10

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Cancelled entries and their counter-entries no longer move any money. */
const isLive = (e: JournalEntry) => !e.offsetTransactionId && e.transactionType !== "Annullering"

/**
 * What øreavrunding entries dated in the month moved on the Checkin account: entries between the
 * Checkin account and the rounding account, booked by us or by hand.
 */
async function findRounded(client: Fiken, config: Config, month: string): Promise<number> {
  const entries = await client.journalEntriesBetween(`${month}-01`, lastDayOfMonth(month))
  return entries
    .filter((e) => isLive(e) && e.lines.some((l) => l.account === config.reconcile.roundingAccount))
    .flatMap((e) => e.lines)
    .filter((l) => l.account === config.checkinAccount)
    .reduce((s, l) => s + l.amount, 0)
}

/**
 * Marks payouts that are already moved from the Checkin account in Fiken: either booked by us
 * (the voucher is in the description) or a superføring from the bank reconciliation (an entry
 * with the same amount on the Checkin account, near the payout date).
 */
async function findExistingTransfers(
  client: Fiken,
  config: Config,
  transfers: Transfer[],
): Promise<Transfer[]> {
  if (transfers.length === 0) return []
  const dates = transfers.map((t) => t.date).sort()
  const entries = await client.journalEntriesBetween(
    addDays(dates[0] ?? "", -TRANSFER_WINDOW_BEFORE),
    addDays(dates.at(-1) ?? "", TRANSFER_WINDOW_AFTER),
  )
  const live = entries.filter(isLive)
  const used = new Set<number>()
  const take = (match: (e: JournalEntry) => boolean) => {
    const entry = live.find((e) => !used.has(e.journalEntryId) && match(e))
    if (entry) used.add(entry.journalEntryId)
    return entry
  }

  return transfers.map((t) => {
    // "bilag 17342:1" must not match "bilag 17342:13".
    const voucher = new RegExp(`bilag ${t.voucher.replace(/[^\d:]/g, "")}(?!\\d)`)
    const byVoucher = take((e) => voucher.test(e.description ?? ""))
    const byAmount =
      byVoucher ??
      take(
        (e) =>
          e.date !== undefined &&
          e.date >= addDays(t.date, -TRANSFER_WINDOW_BEFORE) &&
          e.date <= addDays(t.date, TRANSFER_WINDOW_AFTER) &&
          e.lines.some(
            (l) => l.account === config.checkinAccount && Math.abs(l.amount) === t.amount,
          ),
      )
    return byAmount
      ? {
          ...t,
          existing: {
            journalEntryId: byAmount.journalEntryId,
            description: byAmount.description ?? undefined,
          },
        }
      : t
  })
}

/** A sale or purchase for the month that is already in Fiken. */
export interface BookedVoucher {
  id: number
  /** Sale number or purchase identifier, e.g. "Checkin 2026-03". */
  number?: string
  date?: string
  lines: (BookedLine & { description?: string })[]
  gross: number
}

export interface Booked {
  sales: BookedVoucher[]
  purchases: BookedVoucher[]
}

function toBooked(id: number, number: string | null | undefined, v: SaleResult | PurchaseResult) {
  const lines = v.lines.map((l: ResultLine) => ({
    description: l.description ?? undefined,
    account: l.account ?? "",
    vatType: l.vatType ?? "NONE",
    netPrice: l.netPrice ?? 0,
    vat: l.vat ?? 0,
  }))
  return {
    id,
    number: number ?? undefined,
    date: v.date ?? undefined,
    lines,
    gross: lines.reduce((s, l) => s + l.netPrice + l.vat, 0),
  }
}

/**
 * Sales and purchases for the month already in Fiken: the ones with our reference, and anything
 * dated in the month and paid to or from the Checkin account (months booked by hand).
 */
export async function findBooked(
  client: Fiken,
  config: Config,
  prepared: Prepared,
): Promise<Booked> {
  const { month, reference } = prepared
  const from = `${month}-01`
  const to = lastDayOfMonth(month)
  const viaCheckin = (v: {
    paymentAccount?: string | null
    payments?: { account?: string | null }[] | null
  }) =>
    v.paymentAccount === config.checkinAccount ||
    (v.payments ?? []).some((p) => p.account === config.checkinAccount)

  const sales = new Map<number, SaleResult>()
  for (const s of [
    ...(await client.findSales(reference)),
    ...(await client.salesBetween(from, to)).filter((s) =>
      viaCheckin({ paymentAccount: s.paymentAccount, payments: s.salePayments }),
    ),
  ]) {
    if (!s.deleted) sales.set(s.saleId, s)
  }
  const purchases = (await client.purchasesBetween(from, to)).filter(
    (p) => !p.deleted && (p.identifier === reference || viaCheckin(p)),
  )
  return {
    sales: [...sales.values()].map((s) => toBooked(s.saleId, s.saleNumber, s)),
    purchases: purchases.map((p) => toBooked(p.purchaseId, p.identifier, p)),
  }
}

export interface Audit {
  booked: Booked
  /** The payouts, with the ones found in Fiken marked `existing`. */
  transfers: Transfer[]
  checkin: FikenCheckinAccount
  /** What is in Fiken against the report. */
  checks: Check[]
  /** The fri postering that evens out øreavrunding, if the month is a few øre off. See `bookRounding`. */
  rounding?: RoundingCorrection
}

/** Checks a month that is already booked against its report. Never writes. */
export async function auditBooked(
  client: Fiken,
  config: Config,
  prepared: Prepared,
  booked?: Booked,
): Promise<Audit> {
  const { month, plan } = prepared
  const found = booked ?? (await findBooked(client, config, prepared))
  const transfers = await findExistingTransfers(client, config, prepared.transfers)
  const checkin: FikenCheckinAccount = {
    code: config.checkinAccount,
    start: await client.accountBalance(config.checkinAccount, lastDayOfPreviousMonth(month)),
    end: await client.accountBalance(config.checkinAccount, plan.date),
  }
  const gross = (vs: BookedVoucher[]) => vs.reduce((s, v) => s + v.gross, 0)
  const rounded = await findRounded(client, config, month)
  const sums = { sale: gross(found.sales), purchase: gross(found.purchases) }
  // Only a month with both its sale and purchase in Fiken can be off by rounding.
  const complete =
    found.sales.length > 0 && (plan.purchase.lines.length === 0 || found.purchases.length > 0)
  const drift = complete ? roundingDrift(plan, sums, rounded) : undefined
  return {
    booked: found,
    transfers,
    checkin,
    rounding: drift && roundingCorrection(plan, drift, { ...config, ...config.reconcile }),
    checks: [
      ...verifyBooked(plan, {
        sale: found.sales.flatMap((v) => v.lines),
        purchase: found.purchases.flatMap((v) => v.lines),
      }),
      ...(drift ? verifyRounding(drift, config.checkinAccount) : []),
      ...verifyTransfersBooked(transfers),
      ...reconcileBooked({ ...sums, rounded }, prepared.source, checkin, config.reconcile),
    ],
  }
}

/**
 * Books the øreavrunding `auditBooked` found for a month booked with Fiken's VAT: a fri postering
 * between the Checkin account and the rounding account on the last day of the month, with the
 * bilag attached. Callers must have shown it and gotten confirmation. Refuses if Fiken has changed
 * since the audit, so the same rounding is never booked twice.
 */
export async function bookRounding(
  client: Fiken,
  config: Config,
  prepared: Prepared,
  audit: Audit,
  mode: Exclude<Mode, "dry-run">,
  onStep: (step: string) => void = () => {},
): Promise<BookResult> {
  const r = audit.rounding
  if (!r) throw new Error("Det er ingen øreavrunding å føre for måneden")
  if ((await findRounded(client, config, prepared.month)) !== r.rounded)
    throw new Error("Øreavrundingen er endret i Fiken siden kontrollen. Oppdater og se over igjen.")
  const steps: string[] = []
  const step = (s: string) => {
    steps.push(s)
    onStep(s)
  }
  const open = mode === "draft"
  const entryId = await client.createGeneralJournalEntry({
    description: r.description,
    open,
    journalEntries: [
      {
        description: r.description,
        date: r.date,
        lines: [
          {
            amount: Math.abs(r.amount),
            debitAccount: r.debitAccount,
            creditAccount: r.creditAccount,
          },
        ],
      },
    ],
  })
  step(
    `Øreavrunding ført som ${open ? "åpen " : ""}fri postering: ${formatNok(Math.abs(r.amount))} fra ${r.creditAccount} til ${r.debitAccount} (id ${entryId})`,
  )
  const doc = prepared.source.doc
  if (doc) {
    await client.attachInboxDocument({ kind: "journalEntry", id: entryId }, doc.documentId)
    step("Bilaget lagt ved øreavrundingen")
  }
  if (open) return { steps }
  return {
    steps,
    balance: {
      actual: await client.accountBalance(config.checkinAccount, r.date),
      expected: audit.checkin.end + r.amount,
    },
  }
}

/** The lines as sent to Fiken: a rounded line says so in its text, with Checkin's numbers. */
function fikenLines(prepared: Prepared, side: Rounding["side"]): OrderLine[] {
  return prepared.plan[side].lines.map((line) => {
    const r = prepared.adjusted.find((a) => a.side === side && a.description === line.description)
    return r ? { ...line, description: roundingLineText(r) } : line
  })
}

function toDraft(
  plan: Plan,
  lines: OrderLine[],
  gross: number,
  invoiceNumber: string,
  account: string,
  contactId?: number,
): DraftRequest {
  return {
    invoiceNumber,
    contactId,
    invoiceIssueDate: plan.date,
    cash: true,
    paid: true,
    currency: "NOK",
    lines: lines.map((l) => ({
      text: l.description,
      vatType: l.vatType,
      incomeAccount: l.account,
      net: l.netPrice,
      gross: l.netPrice + (l.vat ?? 0),
    })),
    payments: [{ date: plan.date, account, amount: gross }],
  }
}

export interface BookResult {
  /** What was done, in order; on failure these are what exists in Fiken. */
  steps: string[]
  /** Balance on the Checkin account after a real booking, and what it should be. */
  balance?: { actual: number; expected: number }
}

const PART_NAMES: Record<Part, string> = {
  sale: "salget",
  purchase: "kjøpet",
  transfers: "utbetalingene",
}

/**
 * Writes the chosen parts to Fiken. `onStep` is called after each completed step, so a failure
 * halfway can be reported precisely. Callers must have shown the plan and checks and gotten
 * confirmation. A part already in Fiken is refused, so a month is never booked twice.
 */
export async function book(
  client: Fiken,
  config: Config,
  prepared: Prepared,
  fiken: FikenState,
  mode: Exclude<Mode, "dry-run">,
  parts: Parts,
  onStep: (step: string) => void = () => {},
): Promise<BookResult> {
  if (fiken.blockers.length > 0) throw new Error(`Kan ikke føre: ${fiken.blockers.join("; ")}`)
  const open = bookable(prepared, fiken)
  for (const part of PARTS)
    if (parts[part] && !open[part])
      throw new Error(`Kan ikke føre ${PART_NAMES[part]}: ligger allerede i Fiken eller er tomt`)
  if (!PARTS.some((part) => parts[part])) throw new Error("Ingenting er valgt å føre")
  const { plan, reference } = prepared
  const doc = fiken.doc
  const steps: string[] = []
  const step = (s: string) => {
    steps.push(s)
    onStep(s)
  }

  if (mode === "draft") {
    if (parts.sale) {
      const saleDraftId = await client.createSaleDraft(
        toDraft(
          plan,
          fikenLines(prepared, "sale"),
          plan.sale.gross,
          reference,
          config.checkinAccount,
          fiken.customer?.contactId,
        ),
      )
      step(`Salgsutkast laget (id ${saleDraftId})`)
      if (doc) {
        await client.attachInboxDocument({ kind: "saleDraft", id: saleDraftId }, doc.documentId)
        step("Bilaget lagt ved salgsutkastet")
      }
    }
    if (parts.purchase) {
      const purchaseDraftId = await client.createPurchaseDraft(
        toDraft(
          plan,
          fikenLines(prepared, "purchase"),
          plan.purchase.gross,
          reference,
          config.checkinAccount,
          fiken.supplier?.contactId,
        ),
      )
      step(`Kjøpsutkast laget (id ${purchaseDraftId})`)
      if (doc) {
        await client.attachInboxDocument(
          { kind: "purchaseDraft", id: purchaseDraftId },
          doc.documentId,
        )
        step("Bilaget lagt ved kjøpsutkastet")
      }
    }
    // Fiken has no drafts for fri posteringer; open entries can be deleted without a counter-entry.
    if (parts.transfers) await bookTransfers(client, config, fiken, step, { open: true })
    return { steps }
  }

  if (parts.sale) {
    const saleId = await client.createSale({
      saleNumber: reference,
      date: plan.date,
      kind: "cash_sale",
      currency: "NOK",
      lines: fikenLines(prepared, "sale"),
      totalPaid: plan.sale.gross,
      paymentAccount: config.checkinAccount,
      paymentDate: plan.date,
      customerId: fiken.customer?.contactId,
    })
    step(`Salg bokført (id ${saleId})`)
    if (doc) {
      await client.attachInboxDocument({ kind: "sale", id: saleId }, doc.documentId)
      step("Bilaget lagt ved salget")
    }
    const saleAccrual = config.sale.accrual
    if (saleAccrual) {
      for (const line of (await client.getSale(saleId)).lines) {
        if (line.lineId === undefined || line.account !== config.sale.account) continue
        await client.accrueSaleLine(saleId, { lineId: line.lineId, ...saleAccrual })
        step(`Periodisert "${line.description}" mot ${saleAccrual.account}`)
      }
    }
  }

  if (parts.purchase) {
    const purchaseId = await client.createPurchase({
      identifier: reference,
      date: plan.date,
      // With a supplier it is a supplier purchase (in the supplier ledger), paid right away.
      kind: fiken.supplier ? "supplier" : "cash_purchase",
      paid: true,
      currency: "NOK",
      lines: fikenLines(prepared, "purchase"),
      paymentAccount: config.checkinAccount,
      paymentDate: plan.date,
      supplierId: fiken.supplier?.contactId,
    })
    step(`Kjøp bokført (id ${purchaseId})`)
    if (doc) {
      await client.attachInboxDocument({ kind: "purchase", id: purchaseId }, doc.documentId)
      step("Bilaget lagt ved kjøpet")
    }
    const purchaseAccrual = config.purchase.accrual
    if (purchaseAccrual) {
      for (const line of (await client.getPurchase(purchaseId)).lines) {
        if (line.lineId === undefined || line.account !== config.purchase.account) continue
        await client.accruePurchaseLine(purchaseId, { lineId: line.lineId, ...purchaseAccrual })
        step(`Periodisert "${line.description}" mot ${purchaseAccrual.account}`)
      }
    }
  }

  const moved = parts.transfers
    ? await bookTransfers(client, config, fiken, step, { open: false })
    : 0

  return {
    steps,
    balance: {
      actual: await client.accountBalance(config.checkinAccount, plan.date),
      expected:
        fiken.checkin.end +
        (parts.sale ? plan.sale.gross : 0) -
        (parts.purchase ? plan.purchase.gross : 0) -
        moved,
    },
  }
}

/** Creates a fri postering per payout not already in Fiken. Returns the total moved. */
async function bookTransfers(
  client: Fiken,
  config: Config,
  fiken: FikenState,
  step: (s: string) => void,
  { open }: { open: boolean },
): Promise<number> {
  let moved = 0
  for (const t of fiken.transfers) {
    if (t.existing) continue
    const entryId = await client.createGeneralJournalEntry({
      description: t.description,
      open,
      journalEntries: [
        {
          description: t.description,
          date: t.date,
          lines: [
            {
              amount: t.amount,
              debitAccount: config.bankAccount,
              creditAccount: config.checkinAccount,
            },
          ],
        },
      ],
    })
    moved += t.amount
    step(
      `Utbetaling ${t.date} ført som ${open ? "åpen " : ""}fri postering: ${formatNok(t.amount)} til ${config.bankAccount} (id ${entryId})`,
    )
    if (fiken.doc) {
      await client.attachInboxDocument({ kind: "journalEntry", id: entryId }, fiken.doc.documentId)
      step(`Bilaget lagt ved utbetaling ${t.voucher}`)
    }
  }
  return moved
}

/**
 * Picks the Fiken company: the first preferred slug the user has access to (their own choice,
 * then `companySlug` from the config), otherwise the user's only company. Undefined means the
 * user has to choose.
 */
export function pickCompany(
  companies: Company[],
  preferred: (string | undefined)[],
): Company | undefined {
  for (const slug of preferred) {
    const company = companies.find((c) => c.slug === slug)
    if (company) return company
  }
  return companies.length === 1 ? companies[0] : undefined
}
