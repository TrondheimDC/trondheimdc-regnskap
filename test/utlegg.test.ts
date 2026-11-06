// Utleggsrapporter: reading the PDF, categories and VAT, the purchase, the checks and booking
// against an in-memory fake of the Fiken client. The PDFs are generated (test/pdf-fixture.ts).

import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { Config } from "../src/lib/config.ts"
import type {
  Contact,
  ContactRequest,
  CurrencyPurchaseRequest,
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
import {
  MARCH_2026,
  UTLEGG_REPORT,
  UTLEGG_REPORT_V2,
  utleggPdf,
  utleggPdfV2,
} from "./pdf-fixture.ts"

const raw = JSON.parse(await readFile(new URL("../regnskap.config.json", import.meta.url), "utf8"))
const config = Config.parse(raw)
if (!config.utlegg) throw new Error("regnskap.config.json has no utlegg recipe")
/** The recipe as it is in the repo: what the regnskapsfører does. */
const recipe = config.utlegg

// The mechanics (deduction, net from gross, moves) are tested with a recipe of their own that
// deducts VAT, so they keep working whatever the real recipe decides.
const testConfig = Config.parse({
  ...raw,
  utlegg: {
    inboxName: "expense-report",
    dueDays: 14,
    categories: [
      { id: "reise", label: "Reise og transport", account: "7140", rate: 12, deduct: true },
      { id: "servering", label: "Servering", account: "6860", rate: 15, deduct: true },
      { id: "crew", label: "Mat til crew og frivillige", account: "5990", rate: 15, deduct: false },
      { id: "materiell", label: "Materiell og rekvisita", account: "6560", rate: 25, deduct: true },
      { id: "annet", label: "Annet", account: "7798", deduct: true },
    ],
    rules: recipe.rules.filter((r) =>
      ["reise", "servering", "crew", "materiell"].includes(r.category),
    ),
  },
})
const utlegg = testConfig.utlegg!
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

describe("the recipe in the repo", () => {
  const placed = (description: string) => {
    const plan = buildUtleggPlan(
      { ...report, rows: [{ ...report.rows[0]!, description, receiptRates: [] }] },
      recipe,
    )
    const p = plan.placements[0]
    return [p?.category, plan.lines[0]?.account]
  }

  test("no utlegg deducts VAT, as the regnskapsfører has booked them", () => {
    expect(recipe.categories.filter((c) => c.deduct !== false).map((c) => c.id)).toEqual([])
  })

  test("Meetup.com is support to another party, our own software is not", () => {
    expect(placed("Meetup.com - BartJS - årsavgift")).toEqual(["meetup-stotte", "7440"])
    expect(placed("Meetup.com abonnement")).toEqual(["meetup-stotte", "7440"])
    expect(placed("Sessionize 2026")).toEqual(["programvare", "6553"])
    expect(placed("Figma abonnement 2026/2027")).toEqual(["programvare", "6553"])
  })

  test("the accounts used before", () => {
    expect(placed("Return flight to Trondheim")).toEqual(["reise", "7145"])
    expect(placed("Express bus")).toEqual(["reise", "7145"])
    expect(placed("Hotell to netter")).toEqual(["overnatting", "7140"])
    expect(placed("Utlegg - ekstraordinært årsmøte")).toEqual(["servering", "6860"])
    expect(placed("Utlegg - printere")).toEqual(["utstyr", "6551"])
    expect(placed("Test av t-skjorter")).toEqual(["profilering", "7321"])
    expect(placed("Teip og kabelstrips")).toEqual(["materiell", "6560"])
    // "mat" inside "materiell" is not food.
    expect(placed("Materiell til TDC 2026")).toEqual(["materiell", "6560"])
    expect(placed("Mat til styremøtet")).toEqual(["servering", "6860"])
    expect(placed("Business lunch")).toEqual(["servering", "6860"])
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

const ACCOUNTS = ["5990", "6560", "6800", "6860", "7140", "7798"].map((code) => ({
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
  | "getContact"
  | "getContactRaw"
  | "updateContact"
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
    getContact: async (id: number) => {
      const c = contacts.find((x) => x.contactId === id)
      if (!c) throw new Error("not found")
      return c
    },
    // Fiken returns more than we read, e.g. the address; a PUT must send it back.
    getContactRaw: async (id: number) => ({
      ...contacts.find((x) => x.contactId === id),
      address: { streetAddress: "Testveien 1", country: "Norge" },
      supplierAccountCode: "2400:20042",
    }),
    updateContact: async (id: number, body: Record<string, unknown>) => {
      log("updateContact", id, body)
    },
    createContact: async (c: ContactRequest) => {
      log("createContact", c)
      contacts.push({ contactId: 99, ...c })
      return 99
    },
    accounts: async () => ACCOUNTS,
    inbox: async () => [DOC],
    purchasesFrom: async (id: number) => purchases.filter(() => id === 42),
    purchaseDrafts: async () => state.drafts ?? [],
    createPurchase: async (p: PurchaseRequest | CurrencyPurchaseRequest) => {
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

  test("a contact that isn't a supplier blocks", async () => {
    const { client } = fakeFiken({ contacts: [{ ...KARI, supplier: false }] })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.blockers.join()).toMatch(/ikke som leverandør/)
  })

  test("a contact without email and account number gets them from the report when booking", async () => {
    const { client, calls } = fakeFiken({
      contacts: [{ ...KARI, email: null, bankAccountNumber: null }],
    })
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.person).toMatchObject({
      status: "found",
      by: "name",
      update: { email: "kari@example.com", bankAccountNumber: "12345678903" },
    })
    await bookUtlegg(client, prepared, fiken, "create")
    expect(calls.map((c) => c.method)).toEqual([
      "updateContact",
      "createPurchase",
      "attachInboxDocument",
    ])
    // What Fiken had is sent back, read-only fields left out, the missing ones filled in.
    expect(calls[0]?.args).toEqual([
      42,
      {
        name: "Kari Testesen",
        supplier: true,
        address: { streetAddress: "Testveien 1", country: "Norge" },
        email: "kari@example.com",
        bankAccountNumber: "12345678903",
      },
    ])
  })

  test("a contact that has email and account number is not touched", async () => {
    const { client, calls } = fakeFiken()
    const fiken = await inspectUtlegg(client, source, prepared.plan, { attach: true })
    expect(fiken.person).not.toHaveProperty("update")
    await bookUtlegg(client, prepared, fiken, "create")
    expect(calls.map((c) => c.method)).not.toContain("updateContact")
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

  test("a used inbox document blocks", async () => {
    const { client } = fakeFiken()
    const used: UtleggSource = { ...source, doc: { ...DOC, status: true } }
    const fiken = await inspectUtlegg(client, used, prepared.plan, { attach: true })
    expect(fiken.blockers).toEqual([expect.stringMatching(/allerede brukt/)])
  })

  test("a payout in EUR to an IBAN is booked in EUR, the person created without account number", async () => {
    const eur = await parseUtleggPdf(
      utleggPdf({
        name: "Anna Utland",
        email: "anna@example.com",
        account: "DE89 3704 0044 0532 0130 00",
        iban: true,
        payoutCurrency: "EUR",
        generated: "06.11.2030",
        receipts: [
          // A train ticket bought in euro, and a Norwegian taxi converted to euro by the form.
          { description: "Tog til flyplassen", date: "01.10.2030", amount: 4000 },
          {
            description: "Taxi Værnes",
            date: "02.10.2030",
            amount: 4389,
            original: { amount: 51200, currency: "NOK", rate: "1 NOK = 0,0857 EUR" },
          },
        ],
      }),
    )
    const eurSource: UtleggSource = { report: eur, doc: DOC, description: "test" }
    const eurPrepared = prepareUtlegg(eurSource, utlegg, { rates: { "#2": 12 } })
    const { plan } = eurPrepared
    expect(plan.currency).toBe("EUR")
    // The euro ticket has no Norwegian VAT; the Norwegian taxi keeps its 12 %.
    expect(plan.placements.map((p) => [p.rate, p.rateBy])).toEqual([
      [0, "currency"],
      [12, "choice"],
    ])
    expect(eurPrepared.checks.filter((c) => !c.ok)).toEqual([])
    expect(eurPrepared.checks.every((c) => c.currency === "EUR")).toBe(true)

    const { client, calls } = fakeFiken({ contacts: [] })
    const fiken = await inspectUtlegg(client, eurSource, plan, { attach: true })
    expect(utleggBlockers(eurPrepared, fiken)).toEqual([])
    // Fiken keeps only Norwegian account numbers on a contact; the IBAN stays in the report.
    expect(fiken.person).toEqual({
      status: "new",
      contact: { name: "Anna Utland", email: "anna@example.com", supplier: true },
    })

    const result = await bookUtlegg(client, eurPrepared, fiken, "create")
    expect(calls[1]).toMatchObject({
      method: "createPurchase",
      args: [
        {
          currency: "EUR",
          kind: "supplier",
          paid: false,
          lines: [
            { netPriceInCurrency: 4000, vatInCurrency: 0, vatType: "NONE" },
            { netPriceInCurrency: 3919, vatInCurrency: 470, vatType: "LOW" },
          ],
        },
      ],
    })
    expect(result.total).toEqual({ actual: 8389, expected: 8389, currency: "EUR" })
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
    expect(result.total).toEqual({ actual: 335150, expected: 335150, currency: "NOK" })
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

describe("format 2", () => {
  const v2 = (over: Partial<Parameters<typeof utleggPdfV2>[0]> = {}) =>
    parseUtleggPdf(
      utleggPdfV2({
        reportId: "UT-20301106-7KQ2",
        generated: "06.11.2030",
        name: "Kari Testesen",
        email: "kari@example.com",
        bank: [["Kontonummer", "1234 56 78903"]],
        receipts: [
          { description: "Taxi", date: "01.10.2030", category: "Reise", payout: 1000 },
          { description: "Teip", date: "02.10.2030", category: "Materiell", payout: 2000 },
        ],
        ...over,
      }),
    )

  test("fields, summary, rows with the form's category, and the receipt pages", async () => {
    const r = await parseUtleggPdf(UTLEGG_REPORT_V2)
    expect(r).toMatchObject({
      format: 2,
      reportId: "UT-20301106-7KQ2",
      count: 4,
      name: "Kari Testesen",
      email: "kari@example.com",
      bankAccount: "12345678903",
      payoutCurrency: "NOK",
      generated: "2030-11-06",
      validationSkipped: false,
      total: 433293,
    })
    expect(
      r.rows.map(({ n, date, formCategory, amount, pages, receiptRates }) => ({
        n,
        date,
        formCategory,
        amount,
        pages,
        receiptRates,
      })),
    ).toEqual([
      {
        n: 1,
        date: "2030-10-09",
        formCategory: "servering",
        amount: 245050,
        pages: [1],
        receiptRates: [15],
      },
      {
        n: 2,
        date: "2030-10-09",
        formCategory: "materiell",
        amount: 38900,
        pages: [2],
        receiptRates: [25],
      },
      {
        n: 3,
        date: "2030-10-10",
        formCategory: "reise",
        amount: 51200,
        pages: [3],
        receiptRates: [],
      },
      {
        n: 4,
        date: "2030-10-01",
        formCategory: "meetup-stotte",
        amount: 98143,
        pages: [4],
        receiptRates: [],
      },
    ])
    expect(r.rows[0]?.description).toBe("Pizza til crew under rigging fredag kveld, 12 store pizza")
    expect(r.rows[3]).toMatchObject({
      description: "Meetup Pro-abonnement, 6 mnd (Meetup: Trondheim JS)",
      original: { amount: 8994, currency: "USD" },
    })
    expect(r.rows[2]?.receiptHasText).toBe(false)
  })

  test("the form's category is used as it is, and the report id names the purchase", async () => {
    const r = await parseUtleggPdf(UTLEGG_REPORT_V2)
    const plan = buildUtleggPlan(r, recipe)
    expect(plan.placements.map((p) => [p.category, p.by])).toEqual([
      ["servering", "form"],
      ["materiell", "form"],
      ["reise", "form"],
      ["meetup-stotte", "form"],
    ])
    expect(plan.lines.map((l) => l.account)).toEqual(["6860", "6560", "7145", "7440"])
    expect(plan.reference).toBe("Utlegg UT-20301106-7KQ2 Kari Testesen")
    // The user can still move a receipt.
    const moved = buildUtleggPlan(r, recipe, { moves: { "#1": "crew" } })
    expect(moved.placements[0]).toMatchObject({ category: "crew", by: "moved" })
  })

  test("the checks pass for a whole report", async () => {
    const { checks } = prepareUtlegg(
      { report: await parseUtleggPdf(UTLEGG_REPORT_V2), description: "test" },
      recipe,
    )
    expect(checks.filter((c) => !c.ok)).toEqual([])
    expect(check(checks, "Antall kvitteringer mot rapporten")?.ok).toBe(true)
    expect(check(checks, "Alle kvitteringene er lagt ved")?.ok).toBe(true)
  })

  test("a lost row or a missing receipt page fails", async () => {
    const lost = prepareUtlegg({ report: await v2({ count: 3 }), description: "test" }, recipe)
    expect(check(lost.checks, "Antall kvitteringer mot rapporten")?.ok).toBe(false)
    const missing = prepareUtlegg(
      { report: await v2({ missingPages: [2] }), description: "test" },
      recipe,
    )
    expect(check(missing.checks, "Alle kvitteringene er lagt ved")).toMatchObject({
      ok: false,
      detail: "Fant ikke kvitteringssiden for #2",
    })
  })

  test("a table that continues on more pages", async () => {
    const receipts = Array.from({ length: 5 }, (_, i) => ({
      description: `Taxi ${i + 1}`,
      date: `0${i + 1}.10.2030`,
      category: "Reise",
      payout: 1000 * (i + 1),
    }))
    const r = await v2({ receipts, rowsPerPage: 2 })
    expect(r.rows.map((x) => [x.n, x.amount, x.pages])).toEqual([
      [1, 1000, [3]],
      [2, 2000, [4]],
      [3, 3000, [5]],
      [4, 4000, [6]],
      [5, 5000, [7]],
    ])
    expect(r.total).toBe(15000)
  })

  test("IBAN in EUR, an unvalidated account, and the full name from the metadata", async () => {
    const r = await v2({
      name: "Stefan ???",
      author: "Stefan Ionescu",
      bank: [
        ["Land", "Tyskland"],
        ["IBAN", "DE89 3704 0044 0532 0130 00"],
        ["BIC", "COBADEFFXXX"],
      ],
      currency: "EUR",
      validationSkipped: true,
    })
    expect(r).toMatchObject({
      name: "Stefan Ionescu",
      iban: "DE89370400440532013000",
      bankAccount: undefined,
      payoutCurrency: "EUR",
      validationSkipped: true,
    })
  })

  test("known as format 2 by the Rapport-ID on page 1 when the metadata is gone", async () => {
    const r = await v2({ noMetadata: true })
    expect(r).toMatchObject({ format: 2, reportId: "UT-20301106-7KQ2", count: 2 })
  })
})

describe("formats", () => {
  test("v1 is the form as it is today; anything else is not read", async () => {
    const { utleggFormat } = await import("../src/lib/utlegg.ts")
    const { pdfPages } = await import("../src/lib/checkin.ts")
    expect(utleggFormat(await pdfPages(UTLEGG_REPORT))).toBe(1)
    expect(utleggFormat(await pdfPages(MARCH_2026))).toBeUndefined()
  })

  test("the form version is read from the PDF metadata; a version we don't know is refused", async () => {
    const { utleggFormat } = await import("../src/lib/utlegg.ts")
    const { pdfPages } = await import("../src/lib/checkin.ts")
    const pages = await pdfPages(UTLEGG_REPORT)
    // The form sets these; nothing about the version is printed on the page.
    expect(utleggFormat(pages, { Keywords: "utleggsrapport, format-2, UT-20301106-7KQ2" })).toBe(2)
    expect(utleggFormat(pages, { Subject: "TrondheimDC utleggsrapport, format 2" })).toBe(2)
    expect(utleggFormat(pages, { Subject: "Utleggsrapport – TrondheimDC" })).toBe(1)

    const v3 = utleggPdf({
      name: "Kari Testesen",
      email: "kari@example.com",
      account: "1234 56 78903",
      generated: "06.11.2030",
      receipts: [{ description: "Taxi", date: "01.10.2030", amount: 1000 }],
      info: {
        Subject: "TrondheimDC utleggsrapport, format 3",
        Keywords: "utleggsrapport format-3",
      },
    })
    await expect(parseUtleggPdf(v3)).rejects.toThrow(/format 3/)
  })

  test("a receipt header that shares its text cell is still linked to its receipt", async () => {
    const { parseUtleggsrapport } = await import("../src/lib/utlegg.ts")
    const cell = (text: string, x0: number, y: number) => ({ text, x0, x1: x0 + 200, y, h: 10 })
    const pages = [
      [
        [cell("Utleggsrapport", 50, 800)],
        [cell("Rapportinfo", 50, 780)],
        [cell("Beskrivelse", 75, 500), cell("Beløp (NOK)", 417, 500)],
        [
          cell("1", 50, 480),
          cell("Taxi", 75, 480),
          cell("01.10.2030", 238, 480),
          cell("1 000,00", 515, 480),
        ],
        [cell("Total: 1 000,00 NOK", 437, 300)],
      ],
      [[cell("iDEAL | Wero online banking Bilag for utlegg #1: Taxi (1. oktober 2030)", 20, 820)]],
    ]
    const report = parseUtleggsrapport(pages)
    expect(report.rows[0]?.pages).toEqual([1])
  })

  test("inboxName matches one name or several", () => {
    const withNames = { ...utlegg, inboxName: ["expense-report", "utleggsrapport"] }
    expect(withNames.inboxName).toEqual(["expense-report", "utleggsrapport"])
  })
})
