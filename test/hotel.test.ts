// The hotel's conference invoice: reading the PDF, categories, the purchase, the checks and booking
// against an in-memory fake of the Fiken client. The PDF is generated (test/pdf-fixture.ts).

import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { Config } from "../src/lib/config.ts"
import type {
  Contact,
  DraftRequest,
  EhfDocument,
  Fiken,
  PurchaseRequest,
  PurchaseResult,
} from "../src/lib/fiken.ts"
import {
  buildHotelPlan,
  groupByBill,
  type HotelInvoice,
  parseAccountsArg,
  parseHotelInvoicePdf,
  parseMovesArg,
  rateOf,
} from "../src/lib/hotel.ts"
import {
  bookHotel,
  type HotelSource,
  hotelBlockers,
  inspectHotel,
  prepareHotel,
} from "../src/lib/hotel-booking.ts"
import { HOTEL_INVOICE, hotelInvoicePdf } from "./pdf-fixture.ts"

const config = Config.parse(
  JSON.parse(await readFile(new URL("../regnskap.config.json", import.meta.url), "utf8")),
)
if (!config.hotel) throw new Error("regnskap.config.json has no hotel recipe")
const hotel = config.hotel
const invoice = await parseHotelInvoicePdf(HOTEL_INVOICE)
const TOTAL = 39487500

const categoryOf = (inv: HotelInvoice, moves = {}) => {
  const plan = buildHotelPlan(inv, hotel, { moves })
  return Object.fromEntries(
    groupByBill(plan.placements).map((g) => [
      g.key,
      [...new Set(g.placements.map((p) => p.category))].join("/"),
    ]),
  )
}

describe("reading the invoice", () => {
  test("header, sums per section and rate, VAT specification and total", () => {
    expect(invoice).toMatchObject({
      number: "90000000001",
      date: "2030-10-29",
      dueDate: "2030-11-08",
      kid: "900000000014",
      supplierName: "Hotel Brattøra AS",
      supplierOrgNr: "995857480",
      total: TOTAL,
    })
    expect(invoice.sections).toContainEqual({ section: "Stay", rate: 25, gross: 60000 })
    expect(invoice.sections).toContainEqual({ section: "Conference", rate: 12, gross: 11300000 })
    expect(invoice.vatSpec).toEqual([
      { rate: 12, base: 10528571, vat: 1263429 },
      { rate: 25, base: 22156400, vat: 5539100 },
    ])
    expect(invoice.boxes.total).toBeDefined()
  })

  test("one line per item, with section, bill, quantity and rate, across pages", () => {
    expect(invoice.lines).toHaveLength(22)
    expect(invoice.lines[0]).toMatchObject({
      n: 1,
      section: "Stay",
      bill: "NO121S0000001",
      text: "Stay",
      date: "2030-10-18",
      gross: 270000,
      rate: "mixed",
    })
    // The second page goes on in the same section without repeating its header.
    expect(invoice.lines.find((l) => l.text === "300 x Room Rental")).toMatchObject({
      section: "Conference",
      bill: "NO121S0000011",
      count: 300,
      rate: 12,
    })
    expect(invoice.lines.find((l) => l.text === "Mat 230")).toMatchObject({
      count: -1,
      gross: -42000,
      rate: 25,
    })
    // "Trondheimdc" over the fee is not a bill.
    expect(invoice.lines.at(-1)).toMatchObject({ section: "Fees", bill: undefined })
  })

  test("keeps no guest names", () => {
    const text = JSON.stringify(invoice)
    for (const name of ["TESTESEN", "Prøvesen", "Eksempel", ", 101"])
      expect(text).not.toContain(name)
  })

  test("rejects a PDF that isn't the hotel's invoice", async () => {
    const { MARCH_2026 } = await import("./pdf-fixture.ts")
    await expect(parseHotelInvoicePdf(MARCH_2026)).rejects.toThrow(/faktura fra hotellet/)
  })

  test("rate from net and VAT", () => {
    expect(rateOf(26839286, 3220714)).toBe(12)
    expect(rateOf(-79600, -19900)).toBe(25)
    expect(rateOf(264438, 34562)).toBe("mixed")
    expect(rateOf(22, -22)).toBe("mixed")
    expect(rateOf(10000, 0)).toBe(0)
  })
})

describe("categories", () => {
  test("the recipe's rules place every bill", () => {
    expect(categoryOf(invoice)).toEqual({
      NO121S0000001: "rom",
      NO121S0000002: "rom",
      NO121S0000003: "rom",
      NO121S0000010: "crew/lokaler",
      NO121S0000011: "lokaler/servering",
      NO121S0000020: "crew",
      NO121S0000021: "crew",
      NO121S0000030: "crew",
      NO121S0000031: "servering",
      // A bill with beer is the party, also the soft drinks on it.
      NO121S0000032: "fest",
      NO121S0000033: "crew",
      NO121S0000040: "middag",
      "#22": "gebyr",
    })
  })

  test("a moved line wins over its moved bill, which wins over the rules", () => {
    const moves = parseMovesArg("NO121S0000033=servering,#5=servering,NO121S0000010=lokaler")
    const plan = buildHotelPlan(invoice, hotel, { moves })
    const of = (n: number) => plan.placements.find((p) => p.line.n === n)
    expect(of(19)).toMatchObject({ category: "servering", by: "bill" })
    expect(of(5)).toMatchObject({ category: "servering", by: "line" })
    expect(of(7)).toMatchObject({ category: "lokaler", by: "bill" })
    expect(of(15)).toMatchObject({ category: "crew", by: { rule: 8 } })
  })

  test("lines no rule places stop the booking", () => {
    const plan = buildHotelPlan(invoice, { ...hotel, rules: hotel.rules.slice(0, 4) })
    expect(plan.unplaced.map((l) => l.n)).toContain(5)
    const prepared = prepareHotel(
      { invoice, description: "test" },
      {
        ...hotel,
        rules: hotel.rules.slice(0, 4),
      },
    )
    const check = prepared.checks.find((c) => c.label === "Alle linjene har kategori")
    expect(check?.ok).toBe(false)
    expect(check?.detail).toMatch(/linjer uten kategori \(#5, #7/)
  })

  test("moving to a category the recipe doesn't have fails the check", () => {
    const prepared = prepareHotel({ invoice, description: "test" }, hotel, {
      moves: { "#5": "pizza" },
    })
    expect(prepared.plan.unknown).toEqual(["pizza"])
    expect(prepared.checks.find((c) => c.label === "Alle linjene har kategori")?.ok).toBe(false)
  })

  test("parses moves and accounts from the command line", () => {
    expect(parseMovesArg("no121s0000033=crew, #57=servering")).toEqual({
      NO121S0000033: "crew",
      "#57": "servering",
    })
    expect(parseAccountsArg("crew=5990,lokaler=4590")).toEqual({ crew: "5990", lokaler: "4590" })
    expect(() => parseMovesArg("Pizza=crew")).toThrow(/Ugyldig flytting/)
    expect(() => parseAccountsArg("crew=59")).toThrow(/Ugyldig konto/)
  })
})

describe("the purchase", () => {
  const plan = buildHotelPlan(invoice, hotel)

  test("one line per category and rate, adding up to the invoice total", () => {
    expect(
      plan.lines.map((l) => [l.category, l.rate, l.gross, l.vatType, l.netPrice, l.vat]),
    ).toEqual([
      ["lokaler", 12, 11300000, "LOW", 10089286, 1210714],
      ["servering", 25, 23590000, "HIGH", 18872000, 4718000],
      ["fest", 25, 1280000, "HIGH", 1024000, 256000],
      // Without deduction: the gross, without VAT.
      ["crew", 25, 570500, "NONE", 570500, 0],
      ["middag", 25, 2195000, "NONE", 2195000, 0],
      ["rom", 25, 60000, "NONE", 60000, 0],
      ["rom", 12, 480000, "LOW", 428571, 51429],
      ["gebyr", 12, 12000, "LOW", 10714, 1286],
    ])
    expect(plan.gross).toBe(TOTAL)
    expect(plan.lines.map((l) => l.account)).toEqual([
      "6300",
      "4500",
      "4500",
      "5990",
      "7350",
      "7140",
      "7140",
      "7770",
    ])
    expect(plan.lines.find((l) => l.category === "crew")?.description).toBe(
      "Crew og frivillige, uten fradrag",
    )
    expect(plan.lines.find((l) => l.category === "rom" && l.rate === 25)?.description).toBe(
      "Frokost på hotellrommene, uten fradrag",
    )
  })

  test("rooms are split between 12 % and 25 % to match page 1 exactly", () => {
    const parts = invoice.lines
      .filter((l) => l.section === "Stay")
      .flatMap((l) => plan.split.parts.get(l.n) ?? [])
    const at = (rate: number) =>
      parts.filter((p) => p.rate === rate).reduce((s, p) => s + p.gross, 0)
    expect(at(12)).toBe(480000)
    expect(at(25)).toBe(60000)
    // Before evening out, the per-line split was a few øre off.
    expect(plan.split.sections[0]?.computed[25]).not.toBe(60000)
  })

  test("an account chosen in the review replaces the recipe's", () => {
    const chosen = buildHotelPlan(invoice, hotel, { accounts: { lokaler: "4590" } })
    expect(chosen.lines.find((l) => l.category === "lokaler")?.account).toBe("4590")
  })

  test("all checks pass on a consistent invoice", () => {
    const prepared = prepareHotel({ invoice, description: "test" }, hotel)
    expect(prepared.checks.filter((c) => !c.ok)).toEqual([])
  })

  test("a page-1 sum that doesn't match its lines fails", async () => {
    const misprinted = await parseHotelInvoicePdf(
      hotelInvoicePdf({
        number: "90000000002",
        date: "29.10.2030",
        dueDate: "08.11.2030",
        kid: "1",
        pages: [
          [
            {
              section: "Conference",
              bill: "NO121S0000099, x",
              text: "Hall A",
              date: "19.10.2030",
              parts: [[12, 100000]],
            },
          ],
        ],
        sectionOverrides: { "Conference:12": 110000 },
      }),
    )
    const failed = prepareHotel({ invoice: misprinted, description: "test" }, hotel)
      .checks.filter((c) => !c.ok)
      .map((c) => c.label)
    expect(failed).toContain("Conference 12 %: linjene mot side 1")
    expect(failed).toContain("Alle linjene mot fakturatotal")
  })

  test("an invoice from someone else fails the supplier check", async () => {
    const other = await parseHotelInvoicePdf(
      hotelInvoicePdf({
        number: "1",
        date: "29.10.2030",
        dueDate: "08.11.2030",
        kid: "1",
        supplierOrgNr: "999999998",
        pages: [
          [{ section: "Fees", text: "Invoice fee", date: "29.10.2030", parts: [[12, 12000]] }],
        ],
      }),
    )
    const check = prepareHotel({ invoice: other, description: "test" }, hotel).checks.find(
      (c) => c.label === "Leverandøren på fakturaen",
    )
    expect(check?.ok).toBe(false)
  })

  test("the EHF must be the same invoice as the PDF", () => {
    const ehf = { ...EHF, invoiceNumber: "123", gross: TOTAL - 100 }
    const failed = prepareHotel({ invoice, ehf, description: "test" }, hotel)
      .checks.filter((c) => !c.ok)
      .map((c) => c.label)
    expect(failed).toEqual(["Fakturanummer i EHF-en", "Fakturatotal i EHF-en"])
  })
})

describe("config", () => {
  test("rules must name a category and patterns must be valid", () => {
    const withRule = (rule: object) =>
      Config.safeParse({ ...config, hotel: { ...hotel, rules: [rule] } }).success
    expect(withRule({ category: "crew", text: "pizza" })).toBe(true)
    expect(withRule({ category: "catering", text: "pizza" })).toBe(false)
    expect(withRule({ category: "crew", text: "pizza(" })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Fiken

const HOTEL_CONTACT: Contact = {
  contactId: 77,
  name: "Hotel Brattøra AS",
  organizationNumber: "995857480",
  supplier: true,
  supplierAccountCode: "2400:20077",
}

const EHF: EhfDocument = {
  ehfDocumentId: 9001,
  status: "unprocessed",
  invoiceNumber: "90000000001",
  issueDate: "2030-10-29",
  dueDate: "2030-11-08",
  supplierName: "Hotel Brattøra AS",
  supplierOrganizationNumber: "995857480",
  gross: TOTAL,
  kid: "900000000014",
  documentUrl: "https://api.fiken.no/api/v2/companies/test-as/ehf/9001/file",
}

const ACCOUNTS = ["4500", "5990", "6300", "7140", "7350", "7770"].map((code) => ({
  code,
  name: `Konto ${code}`,
}))

type Client = Pick<
  Fiken,
  | "getCompany"
  | "contacts"
  | "getContact"
  | "accounts"
  | "ehfDocuments"
  | "purchasesBetween"
  | "purchaseDrafts"
  | "createPurchase"
  | "createPurchaseDraft"
  | "getPurchase"
  | "attachEhfDocument"
  | "attachInboxDocument"
>

function fakeFiken(
  state: {
    ehf?: EhfDocument[]
    purchases?: PurchaseResult[]
    drafts?: { draftId: number; invoiceNumber?: string }[]
    accounts?: { code: string; name: string }[]
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = []
  const purchases = [...(state.purchases ?? [])]
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args })
  const client: Client = {
    getCompany: async () => ({ name: "Test AS", slug: "test-as", testCompany: true }),
    contacts: async ({ organizationNumber } = {}) =>
      [HOTEL_CONTACT].filter((c) => c.organizationNumber === organizationNumber),
    getContact: async () => HOTEL_CONTACT,
    accounts: async () => state.accounts ?? ACCOUNTS,
    ehfDocuments: async () => state.ehf ?? [EHF],
    purchasesBetween: async () => purchases,
    purchaseDrafts: async () => state.drafts ?? [],
    createPurchase: async (p: PurchaseRequest) => {
      log("createPurchase", p)
      purchases.push({
        purchaseId: 500,
        identifier: p.identifier,
        date: p.date,
        lines: p.lines,
      })
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
    attachEhfDocument: async (target, id) => {
      log("attachEhfDocument", target, id)
    },
    attachInboxDocument: async (target, id) => {
      log("attachInboxDocument", target, id)
    },
  }
  return { client: client as Fiken, calls }
}

const source: HotelSource = { invoice, description: "test" }

describe("Fiken", () => {
  test("finds the EHF by invoice number, the supplier and the accounts", async () => {
    const { client } = fakeFiken()
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    expect(fiken.ehf?.ehfDocumentId).toBe(9001)
    expect(fiken.supplier).toMatchObject({ contactId: 77, accountCode: "2400:20077" })
    expect(hotelBlockers(prepareHotel(source, hotel), fiken)).toEqual([])
  })

  test("without the EHF in Fiken the invoice can't be attached", async () => {
    const { client } = fakeFiken({ ehf: [] })
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    expect(fiken.blockers[0]).toMatch(/Fant ikke faktura 90000000001 som EHF/)
  })

  test("an account missing in Fiken blocks", async () => {
    const { client } = fakeFiken({ accounts: ACCOUNTS.filter((a) => a.code !== "5990") })
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    expect(hotelBlockers(prepareHotel(source, hotel), fiken)).toEqual([
      "Konto 5990 finnes ikke i kontoplanen i Fiken",
    ])
  })

  test("unplaced lines block", async () => {
    const { client } = fakeFiken()
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    const prepared = prepareHotel(source, { ...hotel, rules: [] })
    expect(hotelBlockers(prepared, fiken)[0]).toMatch(/linjer på .* har ingen kategori/)
    await expect(bookHotel(client, prepared, fiken, "create")).rejects.toThrow(/Kan ikke føre/)
  })

  test("refuses an invoice already booked, by hand, from the EHF or as a draft", async () => {
    const booked = [
      fakeFiken({
        purchases: [{ purchaseId: 1, identifier: "Faktura 90000000001", lines: [] }],
      }),
      fakeFiken({ ehf: [{ ...EHF, status: "processed", purchaseId: 2 }] }),
      fakeFiken({ drafts: [{ draftId: 3, invoiceNumber: "90000000001" }] }),
    ]
    for (const { client } of booked) {
      const fiken = await inspectHotel(client, hotel, source, { attach: true })
      expect(hotelBlockers(prepareHotel(source, hotel), fiken)[0]).toMatch(
        /Faktura 90000000001 (er allerede bokført|ligger som kjøpsutkast)/,
      )
    }
  })

  test("books an unpaid supplier purchase with due date and KID, and attaches the EHF", async () => {
    const { client, calls } = fakeFiken()
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    const prepared = prepareHotel(source, hotel)
    const result = await bookHotel(client, prepared, fiken, "create")

    const purchase = calls.find((c) => c.method === "createPurchase")?.args[0] as PurchaseRequest
    expect(purchase).toMatchObject({
      identifier: "90000000001",
      date: "2030-10-29",
      dueDate: "2030-11-08",
      kid: "900000000014",
      kind: "supplier",
      paid: false,
      supplierId: 77,
    })
    expect(purchase.paymentAccount).toBeUndefined()
    // Only Fiken's fields are sent.
    expect(Object.keys(purchase.lines[0] ?? {}).sort()).toEqual([
      "account",
      "description",
      "netPrice",
      "vat",
      "vatType",
    ])
    expect(calls.find((c) => c.method === "attachEhfDocument")?.args).toEqual([
      { kind: "purchase", id: 500, unpaid: true },
      9001,
    ])
    expect(result.total).toEqual({ actual: TOTAL, expected: TOTAL })
  })

  test("draft mode makes a purchase draft with the EHF", async () => {
    const { client, calls } = fakeFiken()
    const fiken = await inspectHotel(client, hotel, source, { attach: true })
    await bookHotel(client, prepareHotel(source, hotel), fiken, "draft")
    const draft = calls.find((c) => c.method === "createPurchaseDraft")?.args[0] as DraftRequest
    expect(draft).toMatchObject({
      invoiceNumber: "90000000001",
      dueDate: "2030-11-08",
      cash: false,
      paid: false,
      contactId: 77,
    })
    expect(draft.lines.reduce((s, l) => s + l.gross, 0)).toBe(TOTAL)
    expect(calls.map((c) => c.method)).toEqual(["createPurchaseDraft", "attachEhfDocument"])
  })
})

describe("chart of accounts", () => {
  test("groups accounts by class, in account order", async () => {
    const { groupAccounts } = await import("../src/lib/accounts.ts")
    const groups = groupAccounts([
      { code: "7350", name: "Representasjon" },
      { code: "4500", name: "Fremmedytelser" },
      { code: "7140", name: "Reisekostnad" },
      { code: "6300", name: "Leie lokale" },
    ])
    expect(groups.map((g) => [g.klass, g.accounts.map((a) => a.code)])).toEqual([
      ["4", ["4500"]],
      ["6", ["6300"]],
      ["7", ["7140", "7350"]],
    ])
    expect(groups[0]?.label).toBe("4xxx · Varekostnad")
  })
})
