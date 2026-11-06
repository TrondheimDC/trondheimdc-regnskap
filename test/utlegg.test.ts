// Utleggsrapporter: reading the PDF, categories and VAT, the purchase, the checks and booking
// against an in-memory fake of the Fiken client. The PDFs are generated (test/pdf-fixture.ts).

import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { Config } from "../src/lib/config.ts"
import type {
  Contact,
  ContactRequest,
  DraftRequest,
  Fiken,
  InboxDocument,
  PurchaseRequest,
  PurchaseResult,
} from "../src/lib/fiken.ts"
import {
  buildUtleggPlan,
  parseRatesArg,
  parseRowChoicesArg,
  parseUtleggPdf,
  receiptRates,
  vatTerm,
} from "../src/lib/utlegg.ts"
import {
  bookUtlegg,
  inspectUtlegg,
  prepareUtlegg,
  type UtleggSource,
  utleggBlockers,
} from "../src/lib/utlegg-booking.ts"
import { MARCH_2026, UTLEGG_REPORT, utleggPdf } from "./pdf-fixture.ts"

const config = Config.parse(
  JSON.parse(await readFile(new URL("../regnskap.config.json", import.meta.url), "utf8")),
)
if (!config.utlegg) throw new Error("regnskap.config.json has no utlegg recipe")
const utlegg = config.utlegg
const report = await parseUtleggPdf(UTLEGG_REPORT)

const BASE = {
  name: "Kari Testesen",
  email: "kari@example.com",
  account: "1234 56 78903",
  generated: "06.11.2030",
}

const check = (checks: { label: string; ok: boolean }[], label: string) =>
  checks.find((c) => c.label === label)

describe("reading the report", () => {
  test("the person, the payout account and the total", () => {
    expect(report).toMatchObject({
      name: "Kari Testesen",
      email: "kari@example.com",
      bankAccount: "12345678903",
      payoutCurrency: "NOK",
      generated: "2030-11-06",
      validationSkipped: false,
      total: 335150,
    })
  })

  test("one row per receipt, with wrapped descriptions joined and its receipt page", () => {
    expect(
      report.rows.map(({ n, description, date, amount, pages }) => ({
        n,
        description,
        date,
        amount,
        pages,
      })),
    ).toEqual([
      {
        n: 1,
        description: "Pizza til crew under rigging fredag kveld, 12 stk store pizza fra Peppes",
        date: "2030-10-08",
        amount: 245050,
        pages: [1],
      },
      { n: 2, description: "Teip og kabelstrips", date: "2030-10-09", amount: 38900, pages: [2] },
      { n: 3, description: "Taxi Værnes", date: "2030-10-10", amount: 51200, pages: [3] },
    ])
  })

  test("VAT rates named on receipts with text; a photo has none", () => {
    expect(report.rows.map((r) => [r.receiptRates, r.receiptHasText])).toEqual([
      [[15], true],
      [[25], true],
      [[], false],
    ])
    expect(receiptRates("Herav mva 25% 77,80")).toEqual([25])
    expect(receiptRates("MVA 15 % 12,00\n25% moms 3,00")).toEqual([25, 15])
    expect(receiptRates("Sum 25,00 kr")).toEqual([])
  })

  test("a receipt in another currency keeps the original amount", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        name: "Ola Prøvesen",
        email: "ola@example.com",
        account: "1234 56 78903",
        generated: "06.11.2030",
        receipts: [
          {
            description: "Speakergave fra Berlin",
            date: "06.10.2030",
            amount: 27484,
            original: { amount: 2550, currency: "EUR", rate: "1 EUR = 10,7780 NOK" },
          },
        ],
      }),
    )
    expect(r.rows[0]).toMatchObject({ amount: 27484, original: { amount: 2550, currency: "EUR" } })
  })

  test("an IBAN payout and a skipped account check", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        name: "Anna Utland",
        email: "anna@example.com",
        account: "DE89 3704 0044 0532 0130 00",
        iban: true,
        payoutCurrency: "EUR",
        generated: "06.11.2030",
        validationSkipped: true,
        receipts: [{ description: "Tog", date: "01.10.2030", amount: 4000 }],
      }),
    )
    expect(r).toMatchObject({
      bankAccount: undefined,
      iban: "DE89370400440532013000",
      payoutCurrency: "EUR",
      validationSkipped: true,
    })
  })

  test("refuses a PDF that isn't an utleggsrapport", async () => {
    await expect(parseUtleggPdf(MARCH_2026)).rejects.toThrow(/ikke ut som en utleggsrapport/)
  })
})

describe("the purchase", () => {
  const plan = buildUtleggPlan(report, utlegg)

  test("a category from the description and a rate from the receipt, else the category's", () => {
    expect(plan.placements.map((p) => [p.row.n, p.category, p.rate, p.rateBy])).toEqual([
      [1, "crew", 15, "receipt"],
      [2, "materiell", 25, "receipt"],
      [3, "reise", 12, "category"],
    ])
  })

  test("a line per receipt; crew food without deduction, the rest deducted", () => {
    expect(plan.lines).toEqual([
      expect.objectContaining({
        description:
          "#1 Pizza til crew under rigging fredag kveld, 12 stk store pizza fra Peppes (15 % mva, uten fradrag)",
        account: "5990",
        vatType: "NONE",
        netPrice: 245050,
        vat: 0,
      }),
      expect.objectContaining({
        description: "#2 Teip og kabelstrips",
        account: "6560",
        vatType: "HIGH",
        netPrice: 31120,
        vat: 7780,
      }),
      expect.objectContaining({
        description: "#3 Taxi Værnes",
        account: "7140",
        vatType: "LOW",
        netPrice: 45714,
        vat: 5486,
      }),
    ])
    expect(plan.gross).toBe(report.total)
  })

  test("dated the last receipt, due 14 days after the report, named after the person", () => {
    expect(plan).toMatchObject({
      reference: "Utlegg 2030-11-06 Kari Testesen",
      date: "2030-10-10",
      dueDate: "2030-11-20",
    })
  })

  test("the user moves a receipt and picks its rate and account", () => {
    const p = buildUtleggPlan(report, utlegg, {
      moves: { "#3": "annet" },
      rates: { "#3": 25 },
      accounts: { annet: "6800" },
    })
    expect(p.lines[2]).toMatchObject({
      category: "annet",
      account: "6800",
      vatType: "HIGH",
      vat: 10240,
    })
    expect(p.placements[2]).toMatchObject({ by: "moved", rateBy: "choice" })
  })

  test("a foreign receipt has no Norwegian VAT", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        ...BASE,
        receipts: [
          {
            description: "Teip i Berlin",
            date: "06.10.2030",
            amount: 27484,
            original: { amount: 2550, currency: "EUR", rate: "1 EUR = 10,7780 NOK" },
          },
        ],
      }),
    )
    const p = buildUtleggPlan(r, utlegg)
    expect(p.placements[0]).toMatchObject({ rate: 0, rateBy: "currency" })
    expect(p.lines[0]).toMatchObject({
      vatType: "NONE",
      netPrice: 27484,
      description: "#1 Teip i Berlin (EUR)",
    })
  })

  test("a receipt nothing matches has no category and stops the booking", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        ...BASE,
        receipts: [{ description: "Diverse", date: "01.10.2030", amount: 1000 }],
      }),
    )
    const p = buildUtleggPlan(r, utlegg)
    expect(p.lines).toEqual([])
    expect(p.unplaced.map((u) => u.row.n)).toEqual([1])
  })

  test("parses choices from the command line", () => {
    expect(parseRowChoicesArg("#2=materiell, 3=reise")).toEqual({
      "#2": "materiell",
      "#3": "reise",
    })
    expect(parseRatesArg("#1=25,#2=0 %")).toEqual({ "#1": 25, "#2": 0 })
    expect(() => parseRatesArg("#1=8")).toThrow()
  })
})

describe("checks", () => {
  test("a rate guessed from the category fails until the user picks it", () => {
    const guessed = prepareUtlegg({ report, description: "test" }, utlegg)
    expect(check(guessed.checks, "Mva-satsen er lest fra kvitteringen")).toMatchObject({
      ok: false,
      detail: "#3: satt etter kategori",
    })
    const chosen = prepareUtlegg({ report, description: "test" }, utlegg, { rates: { "#3": 12 } })
    expect(chosen.checks.filter((c) => !c.ok)).toEqual([])
  })

  test("the rows against the printed total", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        ...BASE,
        total: 999,
        receipts: [{ description: "Taxi", date: "01.10.2030", amount: 1000 }],
      }),
    )
    const { checks } = prepareUtlegg({ report: r, description: "test" }, utlegg)
    expect(check(checks, "Kvitteringene mot totalen i rapporten")?.ok).toBe(false)
  })

  test("receipts from two VAT terms or years", async () => {
    expect([vatTerm("2030-01-31"), vatTerm("2030-02-01"), vatTerm("2030-03-01")]).toEqual([
      "2030-1",
      "2030-1",
      "2030-2",
    ])
    const r = await parseUtleggPdf(
      utleggPdf({
        ...BASE,
        receipts: [
          { description: "Taxi", date: "28.12.2030", amount: 1000 },
          { description: "Taxi", date: "02.01.2031", amount: 1000 },
        ],
      }),
    )
    const { checks, plan } = prepareUtlegg({ report: r, description: "test" }, utlegg)
    expect(plan.date).toBe("2031-01-02")
    expect(check(checks, "Kvitteringene er fra samme mva-termin")).toMatchObject({
      ok: false,
      detail: "Kvitteringer fra 2030 og 2031; kjøpet dateres 2031-01-02",
    })
  })

  test("a skipped account check fails", async () => {
    const r = await parseUtleggPdf(
      utleggPdf({
        ...BASE,
        validationSkipped: true,
        receipts: [{ description: "Taxi", date: "01.10.2030", amount: 1000 }],
      }),
    )
    const { checks } = prepareUtlegg({ report: r, description: "test" }, utlegg)
    expect(check(checks, "Kontonummeret er sjekket i skjemaet")?.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Fiken

const ACCOUNTS = ["4500", "5990", "6560", "6800", "7140", "7350", "7790"].map((code) => ({
  code,
  name: `Konto ${code}`,
}))

const KARI: Contact = {
  contactId: 42,
  name: "Kari Testesen",
  email: "kari@example.com",
  supplier: true,
  supplierAccountCode: "2400:20042",
  bankAccountNumber: "12345678903",
}

const DOC: InboxDocument = {
  documentId: 7001,
  name: "2030-11-06-kari-testesen-expense-report.pdf",
  filename: "2030-11-06-kari-testesen-expense-report.pdf",
  status: false,
  createdAt: "2030-11-06T10:00:00Z",
  documentUrl: "https://example.invalid/doc",
}

type Client = Pick<
  Fiken,
  | "getCompany"
  | "contacts"
  | "createContact"
  | "accounts"
  | "inbox"
  | "purchasesFrom"
  | "purchaseDrafts"
  | "createPurchase"
  | "createPurchaseDraft"
  | "getPurchase"
  | "attachInboxDocument"
>

function fakeFiken(
  state: {
    contacts?: Contact[]
    purchases?: PurchaseResult[]
    drafts?: { draftId: number; invoiceNumber?: string }[]
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = []
  const contacts = [...(state.contacts ?? [KARI])]
  const purchases = [...(state.purchases ?? [])]
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args })
  const client: Client = {
    getCompany: async () => ({ name: "Test AS", slug: "test-as", testCompany: true }),
    contacts: async ({ email, name } = {}) =>
      contacts.filter(
        (c) =>
          (email === undefined || c.email === email) &&
          (name === undefined || c.name.toLowerCase().includes(name.toLowerCase())),
      ),
    createContact: async (c: ContactRequest) => {
      log("createContact", c)
      contacts.push({ contactId: 99, ...c })
      return 99
    },
    accounts: async () => ACCOUNTS,
    inbox: async () => [DOC],
    purchasesFrom: async (id: number) => purchases.filter(() => id === 42),
    purchaseDrafts: async () => state.drafts ?? [],
    createPurchase: async (p: PurchaseRequest) => {
      log("createPurchase", p)
      purchases.push({ purchaseId: 500, identifier: p.identifier, date: p.date, lines: p.lines })
      return 500
    },
    createPurchaseDraft: async (d: DraftRequest) => {
      log("createPurchaseDraft", d)
      return 600
    },
    getPurchase: async (id: number) => {
      const p = purchases.find((x) => x.purchaseId === id)
      if (!p) throw new Error("not found")
      return p
    },
    attachInboxDocument: async (target, id) => {
      log("attachInboxDocument", target, id)
    },
  }
  return { client: client as Fiken, calls }
}

const source: UtleggSource = { report, doc: DOC, description: "test" }
const prepared = prepareUtlegg(source, utlegg, { rates: { "#3": 12 } })

describe("Fiken", () => {
  test("finds the person by email, and nothing blocks", async () => {
    const { client } = fakeFiken()
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.person).toMatchObject({ status: "found", by: "email", contact: { contactId: 42 } })
    expect(fiken.notes).toEqual([])
    expect(utleggBlockers(prepared, fiken)).toEqual([])
  })

  test("someone new is created as supplier with email and account number", async () => {
    const { client, calls } = fakeFiken({ contacts: [] })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.person).toEqual({
      status: "new",
      contact: {
        name: "Kari Testesen",
        email: "kari@example.com",
        supplier: true,
        bankAccountNumber: "12345678903",
      },
    })
    await bookUtlegg(client, prepared, fiken, "create")
    expect(calls.map((c) => c.method)).toEqual([
      "createContact",
      "createPurchase",
      "attachInboxDocument",
    ])
    expect(calls[1]!.args[0]).toMatchObject({ supplierId: 99, kind: "supplier", paid: false })
  })

  test("a namesake with another email is not the same person", async () => {
    const { client } = fakeFiken({
      contacts: [{ ...KARI, contactId: 43, email: "other@example.com" }],
    })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.person?.status).toBe("new")
  })

  test("another account number in Fiken than in the report blocks", async () => {
    const { client } = fakeFiken({ contacts: [{ ...KARI, bankAccountNumber: "9999.99.99999" }] })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(utleggBlockers(prepared, fiken).join()).toMatch(/Kontonummeret på Kari Testesen i Fiken/)
  })

  test("a contact that isn't a supplier blocks; one without account number gets a note", async () => {
    const { client } = fakeFiken({
      contacts: [{ ...KARI, supplier: false, bankAccountNumber: null }],
    })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.blockers.join()).toMatch(/ikke som leverandør/)
    expect(fiken.notes.join()).toMatch(/har ikke kontonummer i Fiken/)
  })

  test("refuses the same claim twice", async () => {
    const { client } = fakeFiken({
      purchases: [
        { purchaseId: 1, identifier: prepared.plan.reference, date: prepared.plan.date, lines: [] },
      ],
    })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(utleggBlockers(prepared, fiken).join()).toMatch(/allerede bokført/)
  })

  test("a used inbox document and a foreign payout block", async () => {
    const { client } = fakeFiken()
    const foreign: UtleggSource = {
      ...source,
      report: { ...report, payoutCurrency: "EUR" },
      doc: { ...DOC, status: true },
    }
    const fiken = await inspectUtlegg(client, foreign, prepared.plan, { attach: true })
    expect(fiken.blockers).toEqual([
      expect.stringMatching(/Utbetaling i EUR/),
      expect.stringMatching(/allerede brukt/),
    ])
  })

  test("books one unpaid supplier purchase with a due date and attaches the report", async () => {
    const { client, calls } = fakeFiken()
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    const result = await bookUtlegg(client, prepared, fiken, "create")
    expect(calls[0]).toMatchObject({
      method: "createPurchase",
      args: [
        {
          identifier: "Utlegg 2030-11-06 Kari Testesen",
          date: "2030-10-10",
          dueDate: "2030-11-20",
          kind: "supplier",
          paid: false,
          supplierId: 42,
          currency: "NOK",
        },
      ],
    })
    expect(calls[1]).toMatchObject({
      method: "attachInboxDocument",
      args: [{ kind: "purchase", id: 500, unpaid: true }, 7001],
    })
    expect(result.total).toEqual({ actual: 335150, expected: 335150 })
  })

  test("a draft carries the same lines, the person and the report", async () => {
    const { client, calls } = fakeFiken()
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    await bookUtlegg(client, prepared, fiken, "draft")
    const draft = calls[0]!.args[0] as DraftRequest
    expect(draft).toMatchObject({
      invoiceNumber: "Utlegg 2030-11-06 Kari Testesen",
      contactId: 42,
      cash: false,
      paid: false,
    })
    expect(draft.lines.reduce((s, l) => s + l.gross, 0)).toBe(335150)
    expect(calls[1]).toMatchObject({
      method: "attachInboxDocument",
      args: [{ kind: "purchaseDraft", id: 600 }, 7001],
    })
  })

  test("refuses to book while something blocks", async () => {
    const { client, calls } = fakeFiken()
    const guessed = prepareUtlegg(source, utlegg, { moves: { "#3": "ukjent" } })
    const fiken = await inspectUtlegg(client, source, guessed.plan, { attach: true })
    await expect(bookUtlegg(client, guessed, fiken, "create")).rejects.toThrow(/Ukjent kategori/)
    expect(calls).toEqual([])
  })
})
