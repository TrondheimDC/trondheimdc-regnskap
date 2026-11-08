// The utlegg flow, shared by the CLI and the web app:
//   prepareUtlegg()   report -> categories and VAT -> purchase lines, and the checks (offline, pure)
//   inspectUtlegg()   read-only: the person as supplier, chart of accounts, already in Fiken?
//   utleggBlockers()  what stops booking with the current choices (pure)
//   bookUtlegg()      the person as a new supplier if needed, then the purchase or a draft, with
//                     the report attached
// The purchase is unpaid with a due date: the økonomiansvarlig pays it from Fiken, and the payment
// is matched in bankavstemmingen like any supplier invoice. Nothing here prints or prompts.

import type { UtleggConfig } from "./config.ts"
import type {
  Account,
  Contact,
  ContactRequest,
  CurrencyOrderLine,
  Fiken,
  InboxDocument,
  OrderLine,
  ResultLine,
} from "./fiken.ts"
import { type MinTdcResult, verifyMinTdcReport } from "./min-tdc.ts"
import {
  buildUtleggPlan,
  parseUtleggPdf,
  type UtleggChoices,
  type UtleggPlan,
  type UtleggPlanLine,
  type Utleggsrapport,
} from "./utlegg.ts"
import { type Check, verifyUtlegg } from "./verify.ts"

export interface UtleggSource {
  report: Utleggsrapport
  /** The inbox document the report came from; it is attached to the purchase. */
  doc?: InboxDocument
  /** Human-readable origin, e.g. a file name or an inbox document. */
  description: string
  /** Whether Min TDC signed it; only for inbox documents. Shown to the reviewer, never decides anything. */
  minTdc?: MinTdcResult
}

/**
 * Reads the report, and for an inbox document checks Min TDC's signature in its description
 * against the PDF exactly as downloaded. `publicKey` is Min TDC's (utlegg.minTdc.publicKey).
 */
export async function readUtleggSource(
  pdf: Uint8Array,
  origin: { doc: InboxDocument; publicKey: string | undefined } | { file: string },
  description: string,
): Promise<UtleggSource> {
  const report = await parseUtleggPdf(pdf)
  if ("file" in origin) return { report, description }
  const { doc, publicKey } = origin
  const minTdc = await verifyMinTdcReport({ description: doc.description, pdf, report, publicKey })
  return { report, doc, description, minTdc }
}

export interface UtleggPrepared {
  source: UtleggSource
  plan: UtleggPlan
  checks: Check[]
}

/** Offline part: plan and checks. Re-run when the user changes a category or a rate. */
export function prepareUtlegg(
  source: UtleggSource,
  utlegg: UtleggConfig,
  choices: UtleggChoices = {},
): UtleggPrepared {
  const plan = buildUtleggPlan(source.report, utlegg, choices)
  return { source, plan, checks: verifyUtlegg(source.report, plan) }
}

/**
 * Inbox documents that look like utleggsrapporter, newest first, used ones too (`status`), so a
 * report stays open in the app after it is booked.
 */
export async function listUtleggDocuments(
  client: Fiken,
  utlegg: UtleggConfig,
): Promise<InboxDocument[]> {
  const needles = (Array.isArray(utlegg.inboxName) ? utlegg.inboxName : [utlegg.inboxName]).map(
    (n) => n.toLowerCase(),
  )
  const docs = await client.inbox({ status: "all" })
  return docs.filter((d) => {
    const name = `${d.name} ${d.filename}`.toLowerCase()
    return needles.some((needle) => name.includes(needle))
  })
}

/** What booking fills in on a contact in Fiken that lacks it. Never overwrites a value. */
export interface ContactUpdate {
  email?: string
  /** Norwegian account number, 11 digits. */
  bankAccountNumber?: string
}

/** The person in Fiken (with what we would fill in), or the contact we would create. */
export type UtleggPerson =
  | { status: "found"; contact: Contact; by: "email" | "name"; update?: ContactUpdate }
  | { status: "new"; contact: ContactRequest }

export type UtleggExisting =
  | { status: "booked"; purchaseId: number; identifier?: string }
  | { status: "draft"; draftId: number }

export interface UtleggFikenState {
  company: { name: string; slug: string; testCompany?: boolean }
  person?: UtleggPerson
  doc?: InboxDocument
  /** Expense accounts (4000–8999) in Fiken, to check and pick accounts from. */
  accounts: Account[]
  existing?: UtleggExisting
  /** Worth a look, but booking can go ahead, e.g. the contact has no account number in Fiken. */
  notes: string[]
  /** Reasons booking is impossible regardless of the choices in the review. */
  blockers: string[]
}

const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "")

/**
 * The person as a supplier: by email first (the form requires it), then by exact name. Never by a
 * name alone when the contact has another email: that is someone else with the same name.
 */
async function findPerson(
  client: Fiken,
  report: Utleggsrapport,
  blockers: string[],
): Promise<UtleggPerson | undefined> {
  const active = (cs: Contact[]) => cs.filter((c) => !c.inactive)
  if (report.email) {
    const byEmail = active(await client.contacts({ email: report.email })).filter(
      (c) => c.email?.toLowerCase() === report.email?.toLowerCase(),
    )
    if (byEmail.length > 1) {
      blockers.push(
        `${report.email} finnes på ${byEmail.length} kontakter i Fiken (${byEmail.map((c) => `${c.contactId} ${c.name}`).join(", ")}). Slå dem sammen eller deaktiver én.`,
      )
      return undefined
    }
    if (byEmail[0]) return { status: "found", contact: byEmail[0], by: "email" }
  }
  const name = report.name.trim().toLowerCase()
  const byName = active(await client.contacts({ name: report.name })).filter(
    (c) =>
      c.name.trim().toLowerCase() === name &&
      (!c.email || !report.email || c.email.toLowerCase() === report.email.toLowerCase()),
  )
  if (byName.length > 1) {
    blockers.push(
      `${report.name} finnes ${byName.length} ganger i Fiken (${byName.map((c) => c.contactId).join(", ")}). Legg inn e-posten ${report.email ?? ""} på riktig kontakt.`,
    )
    return undefined
  }
  if (byName[0]) return { status: "found", contact: byName[0], by: "name" }
  return {
    status: "new",
    contact: {
      name: report.name.trim(),
      ...(report.email ? { email: report.email } : {}),
      supplier: true,
      ...(report.bankAccount ? { bankAccountNumber: report.bankAccount } : {}),
    },
  }
}

/** Read-only checks against Fiken. Never writes. */
export async function inspectUtlegg(
  client: Fiken,
  source: UtleggSource,
  plan: UtleggPlan,
  options: { attach: boolean },
): Promise<UtleggFikenState> {
  const { report } = source
  const blockers: string[] = []
  const notes: string[] = []
  const company = await client.getCompany()

  if (!report.name.trim()) blockers.push("Fant ikke navnet på personen i rapporten")
  if (options.attach && source.doc?.status)
    blockers.push(`Dokumentet «${source.doc.name}» er allerede brukt som bilag i Fiken`)

  const person = report.name.trim() ? await findPerson(client, report, blockers) : undefined
  if (person?.status === "found") {
    // The list can leave out fields; the contact itself has them all.
    const c = await client.getContact(person.contact.contactId).catch(() => person.contact)
    person.contact = c
    if (!c.supplier)
      blockers.push(
        `${c.name} (kontakt ${c.contactId}) finnes i Fiken, men ikke som leverandør. Huk av «Leverandør» på kontakten i Fiken.`,
      )
    const fikenAccount = digits(c.bankAccountNumber)
    if (report.bankAccount && fikenAccount && fikenAccount !== report.bankAccount)
      blockers.push(
        `Kontonummeret på ${c.name} i Fiken (${c.bankAccountNumber}) er ikke det samme som i rapporten (${report.bankAccount}). Sjekk med personen og rett det i Fiken før utbetaling.`,
      )
    const update: ContactUpdate = {
      ...(report.email && !c.email ? { email: report.email } : {}),
      ...(report.bankAccount && !fikenAccount ? { bankAccountNumber: report.bankAccount } : {}),
    }
    if (Object.keys(update).length > 0) person.update = update
    if (person.by === "name")
      notes.push(`Fant ${c.name} på navn, ikke e-post. Sjekk at det er riktig person.`)
  }

  const accounts = await client.accounts("4000-8999")
  const existing = await findUtleggPurchase(client, plan, report.total ?? plan.gross, person)
  return {
    company,
    person,
    doc: options.attach ? source.doc : undefined,
    accounts,
    existing,
    notes,
    blockers,
  }
}

/** The claim already in Fiken: a purchase from the person with our identifier, or the same day and sum. */
async function findUtleggPurchase(
  client: Fiken,
  plan: UtleggPlan,
  /** The report's total: the plan's sum leaves out receipts not placed yet. */
  total: number,
  person?: UtleggPerson,
): Promise<UtleggExisting | undefined> {
  if (person?.status === "found") {
    const purchases = await client.purchasesFrom(person.contact.contactId)
    const gross = (p: (typeof purchases)[number]) => linesGross(p.lines, plan.currency)
    const same = purchases.find(
      (p) =>
        !p.deleted &&
        (p.identifier === plan.reference || (p.date === plan.date && gross(p) === total)),
    )
    if (same)
      return {
        status: "booked",
        purchaseId: same.purchaseId,
        identifier: same.identifier ?? undefined,
      }
  }
  const draft = (await client.purchaseDrafts()).find((d) => d.invoiceNumber === plan.reference)
  return draft ? { status: "draft", draftId: draft.draftId } : undefined
}

export function describeUtleggExisting(e: UtleggExisting): string {
  return e.status === "draft"
    ? `ligger som kjøpsutkast i Fiken (id ${e.draftId})`
    : `er allerede bokført i Fiken (kjøp «${e.identifier ?? ""}», id ${e.purchaseId})`
}

/** Everything that stops booking with the plan as it is now. */
export function utleggBlockers(prepared: UtleggPrepared, fiken: UtleggFikenState): string[] {
  const { plan } = prepared
  const blockers = [...fiken.blockers]
  if (fiken.existing) blockers.push(`Kravet ${describeUtleggExisting(fiken.existing)}`)
  if (!fiken.person) blockers.push("Finner ikke personen i Fiken og kan ikke opprette den")
  if (plan.lines.length === 0) blockers.push("Ingen kvitteringer å føre")
  if (plan.unplaced.length > 0)
    blockers.push(
      `${plan.unplaced.length} kvitteringer mangler kategori, mva-sats eller beløp (${plan.unplaced.map((p) => `#${p.row.n}`).join(", ")})`,
    )
  if (plan.unknown.length > 0) blockers.push(`Ukjent kategori: ${plan.unknown.join(", ")}`)
  const codes = new Set(fiken.accounts.map((a) => a.code))
  for (const account of new Set(plan.lines.map((l) => l.account)))
    if (!codes.has(account)) blockers.push(`Konto ${account} finnes ikke i kontoplanen i Fiken`)
  return blockers
}

/** The lines as sent to Fiken, without our own fields. */
export function utleggOrderLines(lines: UtleggPlanLine[]): OrderLine[] {
  return lines.map(({ description, netPrice, vat, account, vatType }) => ({
    description,
    netPrice,
    vat,
    account,
    vatType,
  }))
}

/** The same lines for a purchase in another currency: amounts in that currency. */
export function utleggCurrencyLines(lines: UtleggPlanLine[]): CurrencyOrderLine[] {
  return lines.map(({ description, netPrice, vat, account, vatType }) => ({
    description,
    netPriceInCurrency: netPrice,
    vatInCurrency: vat,
    account,
    vatType,
  }))
}

/** Sum of a purchase's lines as Fiken has them, in the purchase's currency. */
function linesGross(lines: ResultLine[], currency: string): number {
  return lines.reduce(
    (s, l) =>
      s +
      (currency === "NOK"
        ? (l.netPrice ?? 0) + (l.vat ?? 0)
        : (l.netPriceInCurrency ?? 0) + (l.vatInCurrency ?? 0)),
    0,
  )
}

export interface UtleggBookResult {
  /** What was done, in order; on failure these are what exists in Fiken. */
  steps: string[]
  /** The purchase as Fiken booked it, against the report total, in the payout currency. */
  total?: { actual: number; expected: number; currency?: string }
}

/**
 * Creates the person as supplier if needed, then books the claim as one unpaid supplier purchase
 * (or a draft) with the report attached. Callers must have shown the plan and checks and gotten
 * confirmation. Refuses if anything blocks.
 */
export async function bookUtlegg(
  client: Fiken,
  prepared: UtleggPrepared,
  fiken: UtleggFikenState,
  mode: "draft" | "create",
  onStep: (step: string) => void = () => {},
): Promise<UtleggBookResult> {
  const blockers = utleggBlockers(prepared, fiken)
  if (blockers.length > 0) throw new Error(`Kan ikke føre: ${blockers.join("; ")}`)
  const { plan } = prepared
  const person = fiken.person!
  const steps: string[] = []
  const step = (s: string) => {
    steps.push(s)
    onStep(s)
  }

  let supplierId: number
  if (person.status === "new") {
    supplierId = await client.createContact(person.contact)
    step(`${person.contact.name} lagt inn som leverandør (kontakt ${supplierId})`)
  } else {
    supplierId = person.contact.contactId
    if (person.update) {
      // Before the purchase: if Fiken refuses the update, nothing is booked yet.
      const current = await client.getContactRaw(supplierId)
      await client.updateContact(supplierId, writableContact(current, person.update))
      step(`${describeUpdate(person.update)} lagt inn på ${person.contact.name} i Fiken`)
    }
  }

  if (mode === "draft") {
    const draftId = await client.createPurchaseDraft({
      invoiceNumber: plan.reference,
      invoiceIssueDate: plan.date,
      dueDate: plan.dueDate,
      cash: false,
      paid: false,
      currency: plan.currency,
      contactId: supplierId,
      // Draft lines are in the draft's currency.
      lines: plan.lines.map((l) => ({
        text: l.description,
        vatType: l.vatType,
        incomeAccount: l.account,
        net: l.netPrice,
        gross: l.netPrice + (l.vat ?? 0),
      })),
    })
    step(`Kjøpsutkast laget (id ${draftId})`)
    if (fiken.doc) {
      await client.attachInboxDocument({ kind: "purchaseDraft", id: draftId }, fiken.doc.documentId)
      step("Utleggsrapporten lagt ved")
    }
    return { steps }
  }

  const purchase = {
    identifier: plan.reference,
    date: plan.date,
    dueDate: plan.dueDate,
    kind: "supplier" as const,
    paid: false,
    currency: plan.currency,
    supplierId,
  }
  const purchaseId = await client.createPurchase(
    plan.currency === "NOK"
      ? { ...purchase, lines: utleggOrderLines(plan.lines) }
      : { ...purchase, lines: utleggCurrencyLines(plan.lines) },
  )
  step(
    `Kjøp bokført som gjeld til ${person.contact.name} (id ${purchaseId}), forfall ${plan.dueDate}`,
  )
  if (fiken.doc) {
    await client.attachInboxDocument(
      { kind: "purchase", id: purchaseId, unpaid: true },
      fiken.doc.documentId,
    )
    step("Utleggsrapporten lagt ved")
  }
  const booked = await client.getPurchase(purchaseId)
  return {
    steps,
    total: {
      actual: linesGross(booked.lines, plan.currency),
      expected: plan.gross,
      currency: plan.currency,
    },
  }
}

/**
 * The contact as sent back in a PUT: the fields Fiken lets us write, as Fiken has them, plus what
 * we fill in. Read-only fields (ids, ledger accounts, notes) are left out.
 */
const WRITABLE_CONTACT_FIELDS = [
  "name",
  "email",
  "organizationNumber",
  "customer",
  "supplier",
  "bankAccountNumber",
  "language",
  "inactive",
  "daysUntilInvoicingDueDate",
  "discount",
  "address",
  "groups",
] as const

export function writableContact(
  current: Record<string, unknown>,
  update: ContactUpdate,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of WRITABLE_CONTACT_FIELDS)
    if (current[key] !== undefined && current[key] !== null) body[key] = current[key]
  return { ...body, ...update }
}

/** "E-post og kontonummer 1234 56 78903" */
export function describeUpdate(u: ContactUpdate): string {
  const parts = [
    u.email && `e-post ${u.email}`,
    u.bankAccountNumber && `kontonummer ${u.bankAccountNumber}`,
  ]
    .filter(Boolean)
    .join(" og ")
  return parts.charAt(0).toUpperCase() + parts.slice(1)
}

export const describePerson = (p: UtleggPerson) =>
  p.status === "new"
    ? `Ny leverandør: ${p.contact.name}${p.contact.email ? `, ${p.contact.email}` : ""}${p.contact.bankAccountNumber ? `, konto ${p.contact.bankAccountNumber}` : ""}`
    : `Leverandør: ${p.contact.name} (${p.contact.supplierAccountCode ?? p.contact.contactId})${p.update ? `; legger inn ${describeUpdate(p.update).toLowerCase()}` : ""}`
