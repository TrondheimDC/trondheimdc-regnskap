// Minimal Fiken API v2 client. Spec: https://api.fiken.no/api/v2/docs/swagger.yaml
// All amounts are integers in øre. Fiken only allows one concurrent request and
// slows down above ~4 req/s, so every call goes through a serial queue.

/** The real API. In the browser we go through a same-origin proxy instead, since api.fiken.no has no CORS. */
export const FIKEN_API_URL = "https://api.fiken.no/api/v2"
const MIN_INTERVAL_MS = 300

import { z } from "zod"

export interface Auth {
  /** Current bearer token, refreshing it first if it is about to expire. */
  token(): Promise<string>
  /** Called after a 401; returns false if there is nothing to refresh (personal token). */
  refresh(): Promise<boolean>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const VatType = z.enum(["HIGH", "MEDIUM", "LOW", "NONE", "EXEMPT", "OUTSIDE"])
export type VatType = z.infer<typeof VatType>

export interface OrderLine {
  lineId?: number
  description: string
  netPrice: number
  vat?: number
  account: string
  vatType: VatType
}

export interface SaleRequest {
  saleNumber: string
  date: string
  kind: "cash_sale" | "external_invoice"
  lines: OrderLine[]
  currency: string
  totalPaid?: number
  paymentAccount?: string
  paymentDate?: string
  /** Contact with customer = true; the sale then shows in its customer ledger (1500:XXXXX). */
  customerId?: number
}

export interface PurchaseRequest {
  identifier: string
  date: string
  kind: "cash_purchase" | "supplier"
  paid: boolean
  lines: OrderLine[]
  currency: string
  paymentAccount?: string
  paymentDate?: string
  /** Contact with supplier = true, required for kind "supplier" (supplier ledger 2400:XXXXX). */
  supplierId?: number
}

export interface DraftLine {
  text: string
  vatType: VatType
  incomeAccount: string
  net: number
  gross: number
}

export interface Payment {
  date: string
  account: string
  amount: number
}

export interface DraftRequest {
  invoiceNumber: string
  invoiceIssueDate: string
  cash: boolean
  paid: boolean
  currency: string
  lines: DraftLine[]
  payments?: Payment[]
  /** Customer (sale draft) or supplier (purchase draft). */
  contactId?: number
}

export interface AccrualRequest {
  lineId: number
  startDate: string
  periods: number
  account: string
}

export interface GeneralJournalEntryRequest {
  description: string
  /** Open entries can be deleted without a counter-entry; our "draft" for fri posteringer. */
  open?: boolean
  journalEntries: {
    description: string
    date: string
    lines: { amount: number; debitAccount: string; creditAccount: string }[]
  }[]
}

// Response schemas only declare the fields we use; zod strips the rest.

const ResultLine = z.object({
  lineId: z.number().optional(),
  description: z.string().nullish(),
  account: z.string().nullish(),
  netPrice: z.number().nullish(),
  vat: z.number().nullish(),
  /** Fiken has more VAT types than we book with, so any string is accepted when reading. */
  vatType: z.string().nullish(),
})
export type ResultLine = z.infer<typeof ResultLine>

const PaymentResult = z.object({ account: z.string().nullish(), amount: z.number().nullish() })

const SaleResult = z.object({
  saleId: z.number(),
  saleNumber: z.string().nullish(),
  date: z.string().nullish(),
  lines: z.array(ResultLine),
  paymentAccount: z.string().nullish(),
  salePayments: z.array(PaymentResult).nullish(),
  deleted: z.boolean().optional(),
})
export type SaleResult = z.infer<typeof SaleResult>

const PurchaseResult = z.object({
  purchaseId: z.number(),
  identifier: z.string().nullish(),
  date: z.string().nullish(),
  lines: z.array(ResultLine),
  paymentAccount: z.string().nullish(),
  payments: z.array(PaymentResult).nullish(),
  deleted: z.boolean().optional(),
})
export type PurchaseResult = z.infer<typeof PurchaseResult>

const DraftResult = z.object({
  draftId: z.number(),
  invoiceNumber: z.string().nullish(),
})

const InboxDocument = z.object({
  documentId: z.number(),
  name: z.string(),
  description: z.string().nullish(),
  filename: z.string(),
  status: z.boolean(),
  createdAt: z.string(),
  documentUrl: z.string(),
})
export type InboxDocument = z.infer<typeof InboxDocument>

const BankAccount = z.object({
  bankAccountId: z.number(),
  name: z.string(),
  accountCode: z.string(),
  type: z.string(),
  inactive: z.boolean(),
})

export const Contact = z.object({
  contactId: z.number(),
  name: z.string(),
  organizationNumber: z.string().nullish(),
  customer: z.boolean().optional(),
  supplier: z.boolean().optional(),
  customerAccountCode: z.string().nullish(),
  supplierAccountCode: z.string().nullish(),
  inactive: z.boolean().optional(),
})
export type Contact = z.infer<typeof Contact>

const Company = z.object({
  name: z.string(),
  slug: z.string(),
  organizationNumber: z.string().nullish(),
  testCompany: z.boolean().optional(),
})
export type Company = z.infer<typeof Company>

const JournalEntry = z.object({
  journalEntryId: z.number(),
  description: z.string().nullish(),
  date: z.string().optional(),
  /** Set when the entry has been cancelled (annullert); the counter-entry has type "Annullering". */
  offsetTransactionId: z.number().nullish(),
  transactionType: z.string().nullish(),
  /** Read side of the lines: one account per line, signed amount. */
  lines: z.array(z.object({ account: z.string().nullish(), amount: z.number() })).default([]),
})
export type JournalEntry = z.infer<typeof JournalEntry>

export class FikenError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Fiken ${method} ${path} failed with ${status}: ${body}`)
  }
}

export class Fiken {
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0

  constructor(
    private readonly auth: Auth,
    readonly companySlug: string,
    /** API base URL, e.g. "/api/fiken" behind the nginx proxy. Defaults to the real API. */
    private readonly baseUrl: string = FIKEN_API_URL,
  ) {}

  private company(path: string) {
    return `/companies/${this.companySlug}${path}`
  }

  private request(
    method: string,
    path: string,
    init: {
      json?: unknown
      form?: FormData
      query?: Record<string, string | number | boolean>
      accept?: string
    } = {},
  ): Promise<Response> {
    const run = async () => {
      const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await sleep(wait)

      const url = new URL(
        /^https?:\/\//.test(path) ? path : this.baseUrl + path,
        globalThis.location?.href,
      )
      for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v))

      const headers: Record<string, string> = {
        Accept: init.accept ?? "application/json",
        "X-Request-ID": crypto.randomUUID(),
      }
      let body: BodyInit | undefined
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json"
        body = JSON.stringify(init.json)
      } else if (init.form) {
        body = init.form
      }

      let refreshed = false
      for (let attempt = 0; ; attempt++) {
        headers.Authorization = `Bearer ${await this.auth.token()}`
        this.lastRequestAt = Date.now()
        const res = await fetch(url, { method, headers, body })
        // An expired or revoked OAuth access token: refresh once and retry (nothing was written).
        if (res.status === 401 && !refreshed && (await this.auth.refresh())) {
          refreshed = true
          continue
        }
        if (res.status === 429 && attempt < 4) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        if (!res.ok) throw new FikenError(res.status, method, path, await res.text())
        return res
      }
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  /** GETs every page of a list (Fiken caps pageSize at 100). */
  private async getAll<S extends z.ZodType>(
    item: S,
    path: string,
    query: Record<string, string | number | boolean> = {},
  ): Promise<z.infer<S>[]> {
    const all: z.infer<S>[] = []
    for (let page = 0; ; page++) {
      const res = await this.request("GET", path, { query: { ...query, page, pageSize: 100 } })
      const result = z.array(item).safeParse(await res.json())
      if (!result.success) {
        throw new Error(
          `Unexpected response from Fiken GET ${path}:\n${z.prettifyError(result.error)}`,
        )
      }
      all.push(...result.data)
      const pageCount = Number(res.headers.get("Fiken-Api-Page-Count") ?? 1)
      if (page + 1 >= pageCount || result.data.length === 0) return all
    }
  }

  private async get<S extends z.ZodType>(
    schema: S,
    path: string,
    query?: Record<string, string | number | boolean>,
  ): Promise<z.infer<S>> {
    const json = await (await this.request("GET", path, { query })).json()
    const result = schema.safeParse(json)
    if (!result.success)
      throw new Error(
        `Unexpected response from Fiken GET ${path}:\n${z.prettifyError(result.error)}`,
      )
    return result.data
  }

  /** POSTs and returns the id at the end of the Location header. */
  private async create(path: string, json?: unknown): Promise<number> {
    const res = await this.request("POST", path, { json })
    const location = res.headers.get("Location")
    const id = Number(location?.split("/").pop())
    if (!location || !Number.isFinite(id)) {
      throw new Error(`Fiken POST ${path} returned no usable Location header (${location})`)
    }
    return id
  }

  contacts(query: { organizationNumber?: string; customer?: boolean; supplier?: boolean } = {}) {
    return this.get(z.array(Contact), this.company("/contacts"), { pageSize: 100, ...query })
  }

  getContact(id: number) {
    return this.get(Contact, this.company(`/contacts/${id}`))
  }

  /** The logged-in user (OAuth) or the token owner. */
  me() {
    return this.get(z.object({ name: z.string(), email: z.string() }), "/user")
  }

  companies() {
    return this.get(z.array(Company), "/companies", { pageSize: 100 })
  }

  getCompany() {
    return this.get(Company, this.company(""))
  }

  bankAccounts() {
    return this.get(z.array(BankAccount), this.company("/bankAccounts"), { pageSize: 100 })
  }

  inbox(query: { status?: "all" | "unused" | "used"; name?: string } = {}) {
    return this.get(z.array(InboxDocument), this.company("/inbox"), {
      pageSize: 100,
      sortBy: "createdDate desc",
      ...query,
    })
  }

  createSale(sale: SaleRequest) {
    return this.create(this.company("/sales"), sale)
  }

  getSale(id: number) {
    return this.get(SaleResult, this.company(`/sales/${id}`))
  }

  findSales(saleNumber: string) {
    return this.get(z.array(SaleResult), this.company("/sales"), { saleNumber, pageSize: 100 })
  }

  /** All sales dated within [from, to]. */
  salesBetween(from: string, to: string) {
    return this.getAll(SaleResult, this.company("/sales"), { dateGe: from, dateLe: to })
  }

  createPurchase(purchase: PurchaseRequest) {
    return this.create(this.company("/purchases"), purchase)
  }

  getPurchase(id: number) {
    return this.get(PurchaseResult, this.company(`/purchases/${id}`))
  }

  purchasesOn(date: string) {
    return this.get(z.array(PurchaseResult), this.company("/purchases"), { date, pageSize: 100 })
  }

  /** All purchases dated within [from, to]. */
  purchasesBetween(from: string, to: string) {
    return this.getAll(PurchaseResult, this.company("/purchases"), { dateGe: from, dateLe: to })
  }

  createSaleDraft(draft: DraftRequest) {
    return this.create(this.company("/sales/drafts"), draft)
  }

  saleDrafts() {
    return this.get(z.array(DraftResult), this.company("/sales/drafts"), { pageSize: 100 })
  }

  createPurchaseDraft(draft: DraftRequest) {
    return this.create(this.company("/purchases/drafts"), draft)
  }

  purchaseDrafts() {
    return this.get(z.array(DraftResult), this.company("/purchases/drafts"), { pageSize: 100 })
  }

  journalEntriesOn(date: string) {
    return this.get(z.array(JournalEntry), this.company("/journalEntries"), { date, pageSize: 100 })
  }

  /** All journal entries (of every kind) dated within [from, to]. */
  journalEntriesBetween(from: string, to: string) {
    return this.getAll(JournalEntry, this.company("/journalEntries"), { dateGe: from, dateLe: to })
  }

  accrueSaleLine(saleId: number, accrual: AccrualRequest) {
    return this.create(this.company(`/sales/${saleId}/accruals`), accrual)
  }

  accruePurchaseLine(purchaseId: number, accrual: AccrualRequest) {
    return this.create(this.company(`/purchases/${purchaseId}/accruals`), accrual)
  }

  createGeneralJournalEntry(entry: GeneralJournalEntryRequest) {
    return this.create(this.company("/generalJournalEntries"), entry)
  }

  /** Balance in øre of a bookkeeping account (e.g. "1960:10001") at the end of the given date. */
  async accountBalance(accountCode: string, date: string): Promise<number> {
    const result = await this.get(
      z.object({ balance: z.number() }),
      this.company(`/accountBalances/${encodeURIComponent(accountCode)}`),
      { date },
    )
    return result.balance
  }

  /** Downloads an inbox document (e.g. the Checkin PDF). */
  async downloadInboxDocument(doc: InboxDocument): Promise<Uint8Array> {
    // Never send the API token anywhere but Fiken: only follow links into the API, via our base URL.
    if (!doc.documentUrl.startsWith(`${FIKEN_API_URL}/`)) {
      throw new Error(`Refusing to download inbox document from unexpected URL: ${doc.documentUrl}`)
    }
    const res = await this.request("GET", doc.documentUrl.slice(FIKEN_API_URL.length), {
      accept: "*/*",
    })
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Attaches an existing inbox document; Fiken marks it as used. */
  async attachInboxDocument(
    target:
      | { kind: "sale" | "purchase"; id: number }
      | { kind: "saleDraft" | "purchaseDraft"; id: number }
      | { kind: "journalEntry"; id: number },
    inboxDocumentId: number,
  ): Promise<void> {
    const paths = {
      sale: `/sales/${target.id}/attachments`,
      purchase: `/purchases/${target.id}/attachments`,
      saleDraft: `/sales/drafts/${target.id}/attachments`,
      purchaseDraft: `/purchases/drafts/${target.id}/attachments`,
      journalEntry: `/journalEntries/${target.id}/attachments`,
    }
    const query: Record<string, string | number | boolean> = { inboxDocumentId }
    if (target.kind === "sale" || target.kind === "purchase") {
      query.attachToSale = true
      query.attachToPayment = true
    }
    await this.request("POST", this.company(paths[target.kind]), { query, form: new FormData() })
  }
}
