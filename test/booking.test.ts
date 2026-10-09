// The monthly flow (prepare -> inspectFiken -> book) against an in-memory fake of the Fiken client.
// The fake keeps a ledger of the Checkin account so balances follow what is booked.

import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import {
  auditBooked,
  book,
  bookable,
  type FikenState,
  findBooked,
  findReportDocument,
  inspectFiken,
  type Prepared,
  prepare,
} from "../src/lib/booking.ts"
import { parseReportPdf } from "../src/lib/checkin.ts"
import { Config } from "../src/lib/config.ts"
import type {
  DraftRequest,
  Fiken,
  GeneralJournalEntryRequest,
  InboxDocument,
  JournalEntry,
  PurchaseRequest,
  PurchaseResult,
  SaleRequest,
  SaleResult,
} from "../src/lib/fiken.ts"
import { reconcile } from "../src/lib/verify.ts"
import { MARCH_2026 } from "./pdf-fixture.ts"

const recipe = Config.parse(
  JSON.parse(await readFile(new URL("../regnskap.config.json", import.meta.url), "utf8")),
)
// Without Checkin as a contact; "with a supplier" below covers that.
const config = Config.parse({
  ...recipe,
  sale: { ...recipe.sale, customer: undefined },
  purchase: { ...recipe.purchase, supplier: undefined },
})
const CHECKIN = config.checkinAccount // 1960:10001
const BANK = config.bankAccount // 1920:10001

const DOC: InboxDocument = {
  documentId: 555,
  name: "Regnskapsbilag mars 2026",
  filename: "bilag.pdf",
  status: false,
  createdAt: "2026-04-01T08:00:00Z",
  documentUrl: "https://api.fiken.no/api/v2/companies/test-as/inbox/555/file",
}

// March 2026 fixture: 61 725 sale, 3 055,43 fees, payouts 20 000 (8 Mar) and 30 000 (22 Mar).
const SALE_GROSS = 6172500
const PURCHASE_GROSS = 305543
// 52 000 at the end of February; what Checkin holds after March (1500 + 1921).
const FEB_BALANCE = 5200000
const HELD_AFTER = 6066957

type Client = Pick<
  Fiken,
  | "getCompany"
  | "bankAccounts"
  | "inbox"
  | "saleDrafts"
  | "purchaseDrafts"
  | "findSales"
  | "salesBetween"
  | "purchasesOn"
  | "purchasesBetween"
  | "getContact"
  | "contacts"
  | "journalEntriesBetween"
  | "accountBalance"
  | "createSaleDraft"
  | "createPurchaseDraft"
  | "createSale"
  | "getSale"
  | "createPurchase"
  | "getPurchase"
  | "accrueSaleLine"
  | "accruePurchaseLine"
  | "createGeneralJournalEntry"
  | "attachInboxDocument"
>

class FakeFiken implements Client {
  nextId = 100
  /** Movements on the Checkin account (positive = into the account). */
  ledger: { date: string; amount: number }[] = [{ date: "2026-02-01", amount: FEB_BALANCE }]
  journalEntries: JournalEntry[] = []
  sales: SaleResult[] = []
  purchases: PurchaseResult[] = []
  /** Every write, in order. */
  writes: { kind: string; id?: number; body?: unknown }[] = []
  journalQueries: [string, string][] = []

  /** An entry already in Fiken that moved `amount` from the Checkin account to the bank. */
  addTransfer(date: string, amount: number, extra: Partial<JournalEntry> = {}) {
    const entry: JournalEntry = {
      journalEntryId: ++this.nextId,
      description: "Superføring",
      date,
      lines: [
        { account: CHECKIN, amount: -amount },
        { account: BANK, amount },
      ],
      ...extra,
    }
    this.journalEntries.push(entry)
    if (!entry.offsetTransactionId && entry.transactionType !== "Annullering")
      this.ledger.push({ date, amount: -amount })
    return entry.journalEntryId
  }

  async getCompany() {
    return { name: "Test AS", slug: "test-as", testCompany: true }
  }
  async bankAccounts() {
    return [
      { bankAccountId: 1, name: "Bank", accountCode: BANK, type: "normal", inactive: false },
      { bankAccountId: 2, name: "Checkin", accountCode: CHECKIN, type: "foreign", inactive: false },
    ]
  }
  async inbox() {
    return [DOC]
  }
  saleDraftList: { draftId: number; invoiceNumber?: string }[] = []
  purchaseDraftList: { draftId: number; invoiceNumber?: string }[] = []
  async saleDrafts() {
    return this.saleDraftList
  }
  async purchaseDrafts() {
    return this.purchaseDraftList
  }
  async findSales(saleNumber: string) {
    return this.sales.filter((s) => s.saleNumber === saleNumber)
  }
  async salesBetween(from: string, to: string) {
    return this.sales.filter((s) => s.date && s.date >= from && s.date <= to)
  }
  async purchasesOn(date: string) {
    return this.purchases.filter((p) => p.date === date)
  }
  async purchasesBetween(from: string, to: string) {
    return this.purchases.filter((p) => p.date && p.date >= from && p.date <= to)
  }
  async getContact(contactId: number) {
    return { contactId, name: "Checkin AS", customer: true, supplier: true, inactive: false }
  }
  async contacts() {
    return []
  }
  async journalEntriesBetween(from: string, to: string) {
    this.journalQueries.push([from, to])
    return this.journalEntries.filter((e) => e.date && e.date >= from && e.date <= to)
  }
  async accountBalance(code: string, date: string) {
    expect(code).toBe(CHECKIN)
    return this.ledger.filter((m) => m.date <= date).reduce((s, m) => s + m.amount, 0)
  }
  private created(kind: string, body?: unknown) {
    const id = ++this.nextId
    this.writes.push({ kind, id, body })
    return id
  }
  async createSaleDraft(draft: DraftRequest) {
    return this.created("saleDraft", draft)
  }
  async createPurchaseDraft(draft: DraftRequest) {
    return this.created("purchaseDraft", draft)
  }
  async createSale(sale: SaleRequest) {
    this.ledger.push({ date: sale.paymentDate ?? sale.date, amount: sale.totalPaid ?? 0 })
    const saleId = this.created("sale", sale)
    this.sales.push({ ...sale, saleId })
    return saleId
  }
  async getSale(saleId: number) {
    return { saleId, lines: [] }
  }
  async createPurchase(purchase: PurchaseRequest) {
    const gross = purchase.lines.reduce((s, l) => s + l.netPrice + (l.vat ?? 0), 0)
    this.ledger.push({ date: purchase.paymentDate ?? purchase.date, amount: -gross })
    const purchaseId = this.created("purchase", purchase)
    this.purchases.push({ ...purchase, purchaseId })
    return purchaseId
  }
  async getPurchase(purchaseId: number) {
    return { purchaseId, lines: [] }
  }
  async accrueSaleLine() {
    return this.created("accrual")
  }
  async accruePurchaseLine() {
    return this.created("accrual")
  }
  async createGeneralJournalEntry(entry: GeneralJournalEntryRequest) {
    for (const je of entry.journalEntries)
      for (const line of je.lines) {
        if (line.creditAccount === CHECKIN)
          this.ledger.push({ date: je.date, amount: -line.amount })
        if (line.debitAccount === CHECKIN) this.ledger.push({ date: je.date, amount: line.amount })
      }
    const id = this.created("journalEntry", entry)
    for (const je of entry.journalEntries)
      this.journalEntries.push({
        journalEntryId: id,
        description: je.description,
        date: je.date,
        lines: je.lines.flatMap((l) => [
          { account: l.debitAccount, amount: l.amount },
          { account: l.creditAccount, amount: -l.amount },
        ]),
      })
    return id
  }
  async attachInboxDocument(target: { kind: string; id: number }, inboxDocumentId: number) {
    expect(inboxDocumentId).toBe(DOC.documentId)
    this.writes.push({ kind: `attach:${target.kind}`, id: target.id })
  }

  get client() {
    return this as unknown as Fiken
  }
  written(kind: string) {
    return this.writes.filter((w) => w.kind === kind)
  }
}

async function prepared(cfg = config): Promise<Prepared> {
  const parsed = await parseReportPdf(MARCH_2026)
  return prepare({ ...parsed, doc: DOC, description: "test" }, cfg)
}

/** Prepared with other payouts than the fixture's (the report checks are not re-run). */
function withTransfers(p: Prepared, payouts: [voucher: string, date: string, amount: number][]) {
  return {
    ...p,
    transfers: payouts.map(([voucher, date, amount]) => ({
      voucher,
      date,
      amount,
      description: `03.2026 Innbetaling fra Checkin (bilag ${voucher})`,
    })),
  }
}

const inspect = (fake: FakeFiken, p: Prepared) =>
  inspectFiken(fake.client, config, p, { attach: true })

const ALL = { sale: true, purchase: true, transfers: true }

describe("prepare", () => {
  test("builds one fri postering per payout from the report", async () => {
    const p = await prepared()
    expect(p.reference).toBe("Checkin 2026-03")
    expect(p.transfers).toEqual([
      {
        voucher: "17342:13",
        date: "2026-03-08",
        amount: 2000000,
        description: "03.2026 Innbetaling fra Checkin (bilag 17342:13)",
      },
      {
        voucher: "17342:14",
        date: "2026-03-22",
        amount: 3000000,
        description: "03.2026 Innbetaling fra Checkin (bilag 17342:14)",
      },
    ])
    expect(p.plan.sale.gross).toBe(SALE_GROSS)
    expect(p.plan.purchase.gross).toBe(PURCHASE_GROSS)
    expect(p.checks.every((c) => c.ok)).toBe(true)
  })

  test("a report without payouts has no transfers", async () => {
    const parsed = await parseReportPdf(MARCH_2026)
    const p = prepare({ ...parsed, payouts: [], description: "test" }, config)
    expect(p.transfers).toEqual([])
  })

  test("refuses a month that doesn't match the report", async () => {
    const parsed = await parseReportPdf(MARCH_2026)
    expect(() => prepare({ ...parsed, description: "test" }, config, "2026-04")).toThrow(
      /stemmer ikke/,
    )
  })
})

describe("reconcile with new fri posteringer", () => {
  test("counts the payouts this run will book", async () => {
    const { plan, source } = await prepared()
    // Nothing moved in Fiken yet; this run books both payouts (50 000).
    const fiken = { code: CHECKIN, start: FEB_BALANCE, end: FEB_BALANCE }
    const checks = reconcile(plan, source, fiken, config.reconcile, 5000000)
    expect(checks.map((c) => [c.ok, c.expected, c.actual])).toEqual([
      [true, 5000000, 5000000],
      [true, HELD_AFTER, HELD_AFTER],
    ])
  })

  test("one payout already in Fiken, the other booked now", async () => {
    const { plan, source } = await prepared()
    const fiken = { code: CHECKIN, start: FEB_BALANCE, end: FEB_BALANCE - 2000000 }
    const checks = reconcile(plan, source, fiken, config.reconcile, 3000000)
    expect(checks.map((c) => c.ok)).toEqual([true, true])
  })

  test("a payout neither in Fiken nor booked fails both checks", async () => {
    const { plan, source } = await prepared()
    const fiken = { code: CHECKIN, start: FEB_BALANCE, end: FEB_BALANCE }
    const checks = reconcile(plan, source, fiken, config.reconcile, 3000000)
    expect(checks.map((c) => c.ok)).toEqual([false, false])
    expect(checks[0]!.expected - checks[0]!.actual).toBe(-2000000)
    expect(checks[1]!.expected - checks[1]!.actual).toBe(2000000)
  })

  test("booking a payout twice (already superført by hand) fails the payout check", async () => {
    const { plan, source } = await prepared()
    const fiken = { code: CHECKIN, start: FEB_BALANCE, end: FEB_BALANCE - 5000000 }
    const checks = reconcile(plan, source, fiken, config.reconcile, 5000000)
    expect(checks.map((c) => c.ok)).toEqual([false, false])
  })
})

describe("inspectFiken", () => {
  test("nothing in Fiken: both payouts are new and all checks pass", async () => {
    const fake = new FakeFiken()
    const state = await inspect(fake, await prepared())
    expect(state.blockers).toEqual([])
    expect(state.doc).toEqual(DOC)
    expect(state.transfers.map((t) => t.existing)).toEqual([undefined, undefined])
    expect(state.checkin).toEqual({ code: CHECKIN, start: FEB_BALANCE, end: FEB_BALANCE })
    expect(state.checks.map((c) => c.ok)).toEqual([true, true])
    // -3 days before the first payout, +10 after the last.
    expect(fake.journalQueries).toEqual([["2026-03-05", "2026-04-01"]])
    expect(fake.writes).toEqual([])
  })

  test("finds a payout booked earlier by its voucher in the description", async () => {
    const fake = new FakeFiken()
    const id = fake.addTransfer("2026-03-22", 3000000, {
      description:
        "Fri postering registrert via API: 03.2026 Innbetaling fra Checkin (bilag 17342:14)",
    })
    const state = await inspect(fake, await prepared())
    expect(state.transfers.map((t) => t.existing?.journalEntryId)).toEqual([undefined, id])
    expect(state.checks.map((c) => c.ok)).toEqual([true, true])
  })

  test("a voucher that is a prefix of another does not match", async () => {
    const fake = new FakeFiken()
    fake.addTransfer("2026-03-08", 1000000, { description: "Innbetaling (bilag 17342:13)" })
    const p = withTransfers(await prepared(), [["17342:1", "2026-03-08", 2000000]])
    const state = await inspect(fake, p)
    expect(state.transfers[0]!.existing).toBeUndefined()
  })

  test("finds a superføring by amount on the Checkin account near the payout date", async () => {
    const fake = new FakeFiken()
    // Bank arrival two days after Checkin's "Bokført" date.
    const id = fake.addTransfer("2026-03-10", 2000000)
    const state = await inspect(fake, await prepared())
    expect(state.transfers.map((t) => t.existing?.journalEntryId)).toEqual([id, undefined])
    expect(state.checkin.end).toBe(FEB_BALANCE - 2000000)
    expect(state.checks.map((c) => c.ok)).toEqual([true, true])
  })

  test("two equal payouts don't both match the same journal entry", async () => {
    const fake = new FakeFiken()
    const id = fake.addTransfer("2026-03-09", 2500000)
    const p = withTransfers(await prepared(), [
      ["17342:13", "2026-03-08", 2500000],
      ["17342:14", "2026-03-12", 2500000],
    ])
    const state = await inspect(fake, p)
    expect(state.transfers.map((t) => t.existing?.journalEntryId)).toEqual([id, undefined])
  })

  test("ignores entries outside the date window, on other accounts or cancelled", async () => {
    const fake = new FakeFiken()
    fake.addTransfer("2026-03-04", 2000000) // 4 days before 8 March
    fake.journalEntries.push({
      journalEntryId: 900,
      description: "Annet",
      date: "2026-03-08",
      lines: [
        { account: "1500", amount: -2000000 },
        { account: BANK, amount: 2000000 },
      ],
    })
    fake.addTransfer("2026-03-08", 2000000, {
      description: "03.2026 Innbetaling fra Checkin (bilag 17342:13)",
      offsetTransactionId: 1,
    })
    fake.addTransfer("2026-03-08", 2000000, { transactionType: "Annullering" })
    const state = await inspect(fake, await prepared())
    expect(state.transfers.map((t) => t.existing)).toEqual([undefined, undefined])
  })

  test("blocks when an account is missing", async () => {
    const fake = new FakeFiken()
    const cfg = Config.parse({ ...config, bankAccount: "1920:10009" })
    const state = await inspectFiken(fake.client, cfg, await prepared(), { attach: true })
    expect(state.blockers).toEqual([expect.stringMatching(/Bankkontoen 1920:10009 finnes ikke/)])
    await expect(book(fake.client, cfg, await prepared(), state, "create", ALL)).rejects.toThrow(
      /Kan ikke føre/,
    )
    expect(fake.writes).toEqual([])
  })

  test("a sale already booked is left out, and booking it again is refused", async () => {
    const fake = new FakeFiken()
    fake.sales.push({ saleId: 42, saleNumber: "Checkin 2026-03", lines: [] })
    const p = await prepared()
    const state = await inspect(fake, p)
    expect(state.blockers).toEqual([])
    expect(state.existing.sale).toMatchObject({ status: "booked", vouchers: [{ id: 42 }] })
    expect(bookable(p, state)).toEqual({ sale: false, purchase: true, transfers: true })
    await expect(book(fake.client, config, p, state, "create", ALL)).rejects.toThrow(
      /Kan ikke føre salget/,
    )
    expect(fake.writes).toEqual([])
  })

  test("a draft with our reference counts as in Fiken", async () => {
    const fake = new FakeFiken()
    fake.purchaseDraftList.push({ draftId: 7, invoiceNumber: "Checkin 2026-03" })
    const p = await prepared()
    const state = await inspect(fake, p)
    expect(state.existing).toEqual({ purchase: { status: "draft", draftId: 7 } })
    expect(bookable(p, state).purchase).toBe(false)
  })

  test("blocks when everything is in Fiken already", async () => {
    const fake = new FakeFiken()
    const p = await prepared()
    await book(fake.client, config, p, await inspect(fake, p), "create", ALL)
    const state = await inspect(fake, p)
    expect(bookable(p, state)).toEqual({ sale: false, purchase: false, transfers: false })
    expect(state.blockers).toEqual([expect.stringMatching(/ligger allerede i Fiken/)])
  })
})

describe("book", () => {
  async function run(
    fake: FakeFiken,
    mode: "draft" | "create",
    p?: Prepared,
    cfg = config,
    parts?: Partial<typeof ALL>,
  ) {
    const prep = p ?? (await prepared(cfg))
    const state: FikenState = await inspectFiken(fake.client, cfg, prep, { attach: true })
    expect(state.blockers).toEqual([])
    const steps: string[] = []
    const chosen = { ...bookable(prep, state), ...parts }
    const result = await book(fake.client, cfg, prep, state, mode, chosen, (s) => steps.push(s))
    expect(result.steps).toEqual(steps)
    return result
  }

  const journalBody = (date: string, amount: number, voucher: string, open: boolean) => {
    const description = `03.2026 Innbetaling fra Checkin (bilag ${voucher})`
    return {
      description,
      open,
      journalEntries: [
        {
          description,
          date,
          lines: [{ amount, debitAccount: BANK, creditAccount: CHECKIN }],
        },
      ],
    }
  }

  test("draft mode: sale and purchase drafts plus open fri posteringer, all with the PDF", async () => {
    const fake = new FakeFiken()
    const result = await run(fake, "draft")
    expect(fake.writes.map((w) => w.kind)).toEqual([
      "saleDraft",
      "attach:saleDraft",
      "purchaseDraft",
      "attach:purchaseDraft",
      "journalEntry",
      "attach:journalEntry",
      "journalEntry",
      "attach:journalEntry",
    ])
    const [sale, purchase] = [fake.written("saleDraft")[0]!, fake.written("purchaseDraft")[0]!]
    expect(sale.body).toMatchObject({
      invoiceNumber: "Checkin 2026-03",
      invoiceIssueDate: "2026-03-31",
      cash: true,
      paid: true,
      payments: [{ date: "2026-03-31", account: CHECKIN, amount: SALE_GROSS }],
    })
    expect(purchase.body).toMatchObject({
      payments: [{ date: "2026-03-31", account: CHECKIN, amount: PURCHASE_GROSS }],
    })
    expect(fake.written("journalEntry").map((w) => w.body)).toEqual([
      journalBody("2026-03-08", 2000000, "17342:13", true),
      journalBody("2026-03-22", 3000000, "17342:14", true),
    ])
    // Attachments go to the entry that was just created.
    for (const [i, w] of fake.writes.entries())
      if (w.kind.startsWith("attach:")) expect(w.id).toBe(fake.writes[i - 1]!.id)
    expect(result.balance).toBeUndefined()
    expect(result.steps.filter((s) => s.includes("åpen fri postering"))).toHaveLength(2)
  })

  test("create mode: sale, purchase and a fri postering per payout, balance as expected", async () => {
    const fake = new FakeFiken()
    const result = await run(fake, "create")
    expect(fake.writes.map((w) => w.kind)).toEqual([
      "sale",
      "attach:sale",
      "purchase",
      "attach:purchase",
      "journalEntry",
      "attach:journalEntry",
      "journalEntry",
      "attach:journalEntry",
    ])
    expect(fake.written("sale")[0]!.body).toMatchObject({
      saleNumber: "Checkin 2026-03",
      date: "2026-03-31",
      kind: "cash_sale",
      totalPaid: SALE_GROSS,
      paymentAccount: CHECKIN,
      paymentDate: "2026-03-31",
    })
    expect(fake.written("purchase")[0]!.body).toMatchObject({
      identifier: "Checkin 2026-03",
      kind: "cash_purchase",
      paid: true,
      paymentAccount: CHECKIN,
    })
    expect(fake.written("journalEntry").map((w) => w.body)).toEqual([
      journalBody("2026-03-08", 2000000, "17342:13", false),
      journalBody("2026-03-22", 3000000, "17342:14", false),
    ])
    expect(result.balance).toEqual({ actual: HELD_AFTER, expected: HELD_AFTER })
  })

  test("create mode skips a payout already in Fiken", async () => {
    const fake = new FakeFiken()
    fake.addTransfer("2026-03-09", 2000000)
    const result = await run(fake, "create")
    expect(fake.written("journalEntry").map((w) => w.body)).toEqual([
      journalBody("2026-03-22", 3000000, "17342:14", false),
    ])
    expect(result.balance).toEqual({ actual: HELD_AFTER, expected: HELD_AFTER })
  })

  test("with a supplier the purchase is a supplier purchase, paid at once", async () => {
    const fake = new FakeFiken()
    const cfg = Config.parse({
      ...config,
      sale: { ...config.sale, customer: { contactId: 77 } },
      purchase: { ...config.purchase, supplier: { contactId: 77 } },
    })
    await run(fake, "create", undefined, cfg)
    expect(fake.written("sale")[0]!.body).toMatchObject({ kind: "cash_sale", customerId: 77 })
    expect(fake.written("purchase")[0]!.body).toMatchObject({
      kind: "supplier",
      paid: true,
      supplierId: 77,
      paymentAccount: CHECKIN,
    })
  })

  test("a second run finds its own fri posteringer and books none", async () => {
    const fake = new FakeFiken()
    const p = await prepared()
    // As if the sale and purchase were deleted after the first run, but the entries kept.
    for (const t of p.transfers) fake.addTransfer(t.date, t.amount, { description: t.description })
    const state = await inspect(fake, p)
    expect(state.transfers.every((t) => t.existing)).toBe(true)
  })

  test("sale and purchase only: the payouts are left for later", async () => {
    const fake = new FakeFiken()
    const result = await run(fake, "create", undefined, config, { transfers: false })
    expect(fake.written("journalEntry")).toEqual([])
    expect(result.balance).toEqual({
      actual: FEB_BALANCE + SALE_GROSS - PURCHASE_GROSS,
      expected: FEB_BALANCE + SALE_GROSS - PURCHASE_GROSS,
    })
    // Next time only the payouts are left, and the month adds up.
    const p = await prepared()
    const state = await inspect(fake, p)
    expect(bookable(p, state)).toEqual({ sale: false, purchase: false, transfers: true })
    expect(state.checks.map((c) => c.ok)).toEqual([true, true])
  })

  test("rebooks only an annulled purchase", async () => {
    const fake = new FakeFiken()
    const p = await prepared()
    await book(fake.client, config, p, await inspect(fake, p), "create", ALL)
    // The purchase was wrong and is annulled in Fiken.
    fake.purchases[0]!.deleted = true
    fake.ledger.push({ date: "2026-03-31", amount: PURCHASE_GROSS })

    const state = await inspect(fake, p)
    expect(bookable(p, state)).toEqual({ sale: false, purchase: true, transfers: false })
    expect(state.checks.map((c) => c.ok)).toEqual([true, true])
    const before = fake.writes.length
    const result = await book(fake.client, config, p, state, "create", {
      sale: false,
      purchase: true,
      transfers: false,
    })
    expect(fake.writes.slice(before).map((w) => w.kind)).toEqual(["purchase", "attach:purchase"])
    expect(result.balance).toEqual({ actual: HELD_AFTER, expected: HELD_AFTER })
  })

  test("refuses to book nothing", async () => {
    const fake = new FakeFiken()
    const p = await prepared()
    const state = await inspect(fake, p)
    await expect(
      book(fake.client, config, p, state, "create", {
        sale: false,
        purchase: false,
        transfers: false,
      }),
    ).rejects.toThrow(/Ingenting/)
  })
})

describe("auditBooked", () => {
  async function booked(fake: FakeFiken) {
    const p = await prepared()
    const state = await inspectFiken(fake.client, config, p, { attach: true })
    await book(fake.client, config, p, state, "create", ALL)
    return p
  }

  test("a month booked by the tool: everything matches", async () => {
    const fake = new FakeFiken()
    const p = await booked(fake)
    const writes = fake.writes.length
    const audit = await auditBooked(fake.client, config, p)
    expect(audit.booked.sales.map((s) => [s.number, s.gross])).toEqual([
      ["Checkin 2026-03", SALE_GROSS],
    ])
    expect(audit.booked.purchases.map((s) => [s.number, s.gross])).toEqual([
      ["Checkin 2026-03", PURCHASE_GROSS],
    ])
    expect(audit.transfers.every((t) => t.existing)).toBe(true)
    expect(audit.checks.filter((c) => !c.ok)).toEqual([])
    expect(fake.writes).toHaveLength(writes)
  })

  test("a month booked by hand is found by the payment to the Checkin account", async () => {
    const fake = new FakeFiken()
    const p = await booked(fake)
    fake.sales[0]!.saleNumber = "Billetter mars"
    fake.purchases[0]!.identifier = "Gebyr mars"
    const audit = await auditBooked(fake.client, config, p)
    expect(audit.booked.sales.map((s) => s.number)).toEqual(["Billetter mars"])
    expect(audit.booked.purchases.map((s) => s.number)).toEqual(["Gebyr mars"])
    expect(audit.checks.filter((c) => !c.ok)).toEqual([])
  })

  test("flags a sale booked twice, a missing purchase and a missing payout", async () => {
    const fake = new FakeFiken()
    const p = await booked(fake)
    fake.sales.push({ ...fake.sales[0]!, saleId: 999 })
    fake.purchases[0]!.deleted = true
    fake.journalEntries.pop()
    const audit = await auditBooked(fake.client, config, p)
    const failed = audit.checks.filter((c) => !c.ok).map((c) => c.label)
    expect(failed).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Salg 3000, 25 % mva: netto/),
        expect.stringMatching(/^Kjøp 4300, 25 % mva: netto/),
        expect.stringMatching(/^Utbetaling 2026-03-22 \(Checkin-bilag 17342:14\)/),
      ]),
    )
    const sale = audit.checks.find((c) => c.label.startsWith("Salg 3000, 25 % mva: netto"))!
    expect(sale.expected).toBe(2 * sale.actual)
  })

  test("findBooked ignores sales in the month paid to other accounts", async () => {
    const fake = new FakeFiken()
    fake.sales.push({
      saleId: 1,
      saleNumber: "Sponsor",
      date: "2026-03-15",
      lines: [{ account: "3000", netPrice: 100000, vat: 25000, vatType: "HIGH" }],
      paymentAccount: BANK,
    })
    const found = await findBooked(fake.client, config, await prepared())
    expect(found).toEqual({ sales: [], purchases: [] })
  })
})

test("findReportDocument never picks a document for another month", async () => {
  const doc = (documentId: number, name: string) => ({
    documentId,
    name,
    filename: `${name}.pdf`,
    status: false,
    createdAt: "2026-10-01T08:00:00Z",
    documentUrl: `https://api.fiken.no/api/v2/companies/x/inbox/${documentId}`,
  })
  const client = (docs: ReturnType<typeof doc>[]) =>
    ({ inbox: async () => docs }) as unknown as Parameters<typeof findReportDocument>[0]

  expect(
    (
      await findReportDocument(
        client([doc(1, "Regnskapsbilag 2026-03")]),
        "Regnskapsbilag",
        "2026-09",
      )
    ).match,
  ).toBeUndefined()
  expect(
    (
      await findReportDocument(
        client([doc(1, "Regnskapsbilag 2026-03"), doc(2, "Regnskapsbilag september 2026")]),
        "Regnskapsbilag",
        "2026-09",
      )
    ).match?.documentId,
  ).toBe(2)
  expect(
    (await findReportDocument(client([doc(3, "Regnskapsbilag")]), "Regnskapsbilag", "2026-09"))
      .match?.documentId,
  ).toBe(3)
})
