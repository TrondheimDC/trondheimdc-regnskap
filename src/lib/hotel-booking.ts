// The hotel invoice flow, shared by the CLI and the web app:
//   prepareHotel()   invoice -> categories -> purchase lines, and the checks (offline, pure)
//   inspectHotel()   read-only: supplier, chart of accounts, the EHF, already in Fiken?
//   hotelBlockers()  what stops booking with the current choices (pure, so moving a line in the
//                    review re-runs it without asking Fiken again)
//   bookHotel()      the supplier purchase, or a draft, with the invoice attached
// Nothing here prints or prompts; callers present the plan and ask for confirmation.

import { type ContactInfo, resolveContact } from "./booking.ts"
import type { HotelConfig } from "./config.ts"
import type { Account, EhfDocument, Fiken, InboxDocument, OrderLine } from "./fiken.ts"
import {
  buildHotelPlan,
  type HotelChoices,
  type HotelInvoice,
  type HotelPlan,
  type HotelPlanLine,
} from "./hotel.ts"
import { formatNok } from "./plan.ts"
import { type Check, verifyEhf, verifyHotelInvoice, verifyHotelPlan } from "./verify.ts"

export interface HotelSource {
  invoice: HotelInvoice
  /** The received EHF the PDF came from; it is attached to the purchase. */
  ehf?: EhfDocument
  /** Or an inbox document. */
  doc?: InboxDocument
  /** Human-readable origin, e.g. a file name or "EHF 123". */
  description: string
}

export interface HotelPrepared {
  source: HotelSource
  plan: HotelPlan
  /** The invoice against itself, the purchase against the invoice, and the EHF against the PDF. */
  checks: Check[]
}

/** Offline part: categories, purchase lines and checks. Re-run when the user moves lines. */
export function prepareHotel(
  source: HotelSource,
  hotel: HotelConfig,
  choices: HotelChoices = {},
): HotelPrepared {
  const plan = buildHotelPlan(source.invoice, hotel, choices)
  return {
    source,
    plan,
    checks: [
      ...verifyHotelPlan(plan, source.invoice, hotel.supplier.organizationNumber),
      ...verifyHotelInvoice(source.invoice, plan.split),
      ...(source.ehf ? verifyEhf(source.invoice, source.ehf) : []),
    ],
  }
}

/** The hotel's EHF invoices in Fiken, newest first, unprocessed (still in the inbox) first. */
export async function listHotelInvoices(client: Fiken, hotel: HotelConfig): Promise<EhfDocument[]> {
  const docs = await client.ehfDocuments()
  return docs
    .filter((d) => d.supplierOrganizationNumber === hotel.supplier.organizationNumber)
    .sort(
      (a, b) =>
        Number(a.status !== "unprocessed") - Number(b.status !== "unprocessed") ||
        (b.issueDate ?? "").localeCompare(a.issueDate ?? ""),
    )
}

/** A purchase for the invoice already in Fiken: booked (by us, by hand or from the EHF) or a draft. */
export type HotelExisting =
  | { status: "booked"; purchaseId: number; identifier?: string }
  | { status: "draft"; draftId: number }

export interface HotelFikenState {
  company: { name: string; slug: string; testCompany?: boolean }
  supplier?: ContactInfo
  /** The EHF to attach: the source's, or one Fiken has with the same invoice number. */
  ehf?: EhfDocument
  doc?: InboxDocument
  /** Expense accounts (4000–8999) in Fiken, to check and pick accounts from. */
  accounts: Account[]
  existing?: HotelExisting
  /** Reasons booking is impossible regardless of the choices in the review. */
  blockers: string[]
}

/** Read-only checks against Fiken. Never writes. */
export async function inspectHotel(
  client: Fiken,
  hotel: HotelConfig,
  source: HotelSource,
  options: { attach: boolean },
): Promise<HotelFikenState> {
  const { invoice } = source
  const blockers: string[] = []
  const company = await client.getCompany()

  const supplier = await resolveContact(client, hotel.supplier, "supplier")
  if (typeof supplier === "string") blockers.push(supplier)

  const accounts = await client.accounts("4000-8999")

  // The EHF tells whether Fiken has booked the invoice from it already.
  const ehf =
    source.ehf ??
    (await client.ehfDocuments()).find(
      (d) =>
        d.invoiceNumber === invoice.number &&
        d.supplierOrganizationNumber === hotel.supplier.organizationNumber,
    )
  if (options.attach && !ehf && !source.doc)
    blockers.push(
      `Fant ikke faktura ${invoice.number} som EHF i Fiken, så den kan ikke legges ved kjøpet`,
    )

  const existing = await findHotelPurchase(client, invoice, ehf)
  return {
    company,
    supplier: typeof supplier === "string" ? undefined : supplier,
    ehf: options.attach ? ehf : undefined,
    doc: options.attach ? source.doc : undefined,
    accounts,
    existing,
    blockers,
  }
}

/**
 * The invoice already in Fiken: the EHF booked as a purchase, a purchase in the invoice's year with
 * the invoice number in its identifier, or a purchase draft with it as invoice number.
 */
async function findHotelPurchase(
  client: Fiken,
  invoice: HotelInvoice,
  ehf?: EhfDocument,
): Promise<HotelExisting | undefined> {
  if (ehf?.status === "processed" && ehf.purchaseId)
    return {
      status: "booked",
      purchaseId: ehf.purchaseId,
      identifier: ehf.invoiceNumber ?? undefined,
    }
  const year = invoice.date.slice(0, 4)
  const purchase = (await client.purchasesBetween(`${year}-01-01`, `${year}-12-31`)).find(
    (p) => !p.deleted && (p.identifier ?? "").includes(invoice.number),
  )
  if (purchase)
    return {
      status: "booked",
      purchaseId: purchase.purchaseId,
      identifier: purchase.identifier ?? undefined,
    }
  const draft = (await client.purchaseDrafts()).find((d) => d.invoiceNumber === invoice.number)
  return draft ? { status: "draft", draftId: draft.draftId } : undefined
}

export function describeHotelExisting(e: HotelExisting): string {
  return e.status === "draft"
    ? `ligger som kjøpsutkast i Fiken (id ${e.draftId})`
    : `er allerede bokført i Fiken (kjøp «${e.identifier ?? ""}», id ${e.purchaseId})`
}

/** Everything that stops booking with the plan as it is now. */
export function hotelBlockers(prepared: HotelPrepared, fiken: HotelFikenState): string[] {
  const { plan } = prepared
  const blockers = [...fiken.blockers]
  if (fiken.existing)
    blockers.push(`Faktura ${plan.reference} ${describeHotelExisting(fiken.existing)}`)
  if (plan.unplaced.length > 0)
    blockers.push(
      `${plan.unplaced.length} linjer på ${formatNok(plan.unplaced.reduce((s, l) => s + l.gross, 0))} har ingen kategori`,
    )
  if (plan.unknown.length > 0) blockers.push(`Ukjent kategori: ${plan.unknown.join(", ")}`)
  const codes = new Set(fiken.accounts.map((a) => a.code))
  for (const account of new Set(plan.lines.map((l) => l.account)))
    if (!codes.has(account)) blockers.push(`Konto ${account} finnes ikke i kontoplanen i Fiken`)
  return blockers
}

/** The lines as sent to Fiken, without our own fields. */
export function fikenOrderLines(lines: HotelPlanLine[]): OrderLine[] {
  return lines.map(({ description, netPrice, vat, account, vatType }) => ({
    description,
    netPrice,
    vat,
    account,
    vatType,
  }))
}

export interface HotelBookResult {
  /** What was done, in order; on failure these are what exists in Fiken. */
  steps: string[]
  /** The purchase as Fiken booked it, against the invoice total. */
  total?: { actual: number; expected: number }
}

/**
 * Books the invoice as one supplier purchase, unpaid with due date and KID, so it stays open in
 * the hotel's supplier ledger until the payment is matched in the bank. Callers must have shown
 * the plan and checks and gotten confirmation. Refuses if anything blocks.
 */
export async function bookHotel(
  client: Fiken,
  prepared: HotelPrepared,
  fiken: HotelFikenState,
  mode: "draft" | "create",
  onStep: (step: string) => void = () => {},
): Promise<HotelBookResult> {
  const blockers = hotelBlockers(prepared, fiken)
  if (blockers.length > 0) throw new Error(`Kan ikke føre: ${blockers.join("; ")}`)
  const { plan } = prepared
  const supplierId = fiken.supplier?.contactId
  if (supplierId === undefined) throw new Error("Leverandøren mangler i Fiken")
  const steps: string[] = []
  const step = (s: string) => {
    steps.push(s)
    onStep(s)
  }
  const lines = fikenOrderLines(plan.lines)

  if (mode === "draft") {
    const draftId = await client.createPurchaseDraft({
      invoiceNumber: plan.reference,
      invoiceIssueDate: plan.date,
      dueDate: plan.dueDate,
      kid: plan.kid,
      cash: false,
      paid: false,
      currency: "NOK",
      contactId: supplierId,
      lines: lines.map((l) => ({
        text: l.description,
        vatType: l.vatType,
        incomeAccount: l.account,
        net: l.netPrice,
        gross: l.netPrice + (l.vat ?? 0),
      })),
    })
    step(`Kjøpsutkast laget (id ${draftId})`)
    await attach(client, fiken, { kind: "purchaseDraft", id: draftId }, step)
    return { steps }
  }

  const purchaseId = await client.createPurchase({
    identifier: plan.reference,
    date: plan.date,
    dueDate: plan.dueDate,
    kid: plan.kid,
    kind: "supplier",
    paid: false,
    currency: "NOK",
    lines,
    supplierId,
  })
  step(`Kjøp bokført som leverandørgjeld (id ${purchaseId})`)
  await attach(client, fiken, { kind: "purchase", id: purchaseId, unpaid: true }, step)
  const booked = await client.getPurchase(purchaseId)
  return {
    steps,
    total: {
      actual: booked.lines.reduce((s, l) => s + (l.netPrice ?? 0) + (l.vat ?? 0), 0),
      expected: plan.gross,
    },
  }
}

async function attach(
  client: Fiken,
  fiken: HotelFikenState,
  target: Parameters<Fiken["attachEhfDocument"]>[0],
  step: (s: string) => void,
) {
  if (fiken.ehf) {
    await client.attachEhfDocument(target, fiken.ehf.ehfDocumentId)
    step("EHF-fakturaen lagt ved")
  } else if (fiken.doc) {
    await client.attachInboxDocument(target, fiken.doc.documentId)
    step("Fakturaen lagt ved")
  }
}
