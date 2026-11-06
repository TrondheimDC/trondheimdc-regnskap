// An in-memory Fiken for mock mode (`pnpm dev:mock`): the app runs against MSW handlers instead of
// api.fiken.no, with the same generated PDFs as the tests. Nothing here reaches Fiken, and the
// state lives in the tab (reload to start over). Responses follow the shapes the client reads.

import { HttpResponse, http } from "msw"
import { API_BASE, config } from "@/lib/app-config"
import type {
  Contact,
  ContactRequest,
  DraftRequest,
  GeneralJournalEntryRequest,
  OrderLine,
  PurchaseRequest,
  SaleRequest,
} from "@/lib/fiken"
import { FIKEN_API_URL } from "@/lib/fiken"
import { HOTEL_INVOICE, MARCH_2026, UTLEGG_REPORT } from "../../test/pdf-fixture"

const SLUG = config.companySlug ?? "trondheimdc"
const CHECKIN = config.checkinAccount
const BANK = config.bankAccount
const CHECKIN_ORG = config.purchase.supplier?.organizationNumber ?? "994035053"
const HOTEL_ORG = config.hotel?.supplier.organizationNumber ?? "995857480"

const VAT_RATES: Record<string, number> = { HIGH: 0.25, MEDIUM: 0.15, LOW: 0.12 }

/** Fiken computes VAT when a line has none. */
const withVat = (lines: OrderLine[], from: number) =>
  lines.map((l, i) => ({
    ...l,
    lineId: from + i,
    vat: l.vat ?? Math.round(l.netPrice * (VAT_RATES[l.vatType] ?? 0)),
  }))
const gross = (lines: { netPrice: number; vat?: number }[]) =>
  lines.reduce((s, l) => s + l.netPrice + (l.vat ?? 0), 0)

interface JournalEntry {
  journalEntryId: number
  transactionId: number
  description: string
  date: string
  transactionType: string
  lines: { account: string; amount: number }[]
}

function createState() {
  let nextId = 1000
  const id = () => ++nextId
  return {
    id,
    /** Movements per account (øre); the balance is their sum up to a date. */
    ledger: [
      // What Checkin held at the end of February: 1500 + 1921 in the March fixture.
      { account: CHECKIN, date: "2026-02-28", amount: 5_200_000 },
    ] as { account: string; date: string; amount: number }[],
    inbox: [
      {
        documentId: 7001,
        name: `${config.inbox.reportName} mars 2026`,
        filename: "Regnskapsbilag 2026-03.pdf",
        description: "Mock: generert bilag",
        status: false,
        createdAt: "2026-04-02T08:00:00Z",
        documentUrl: `${FIKEN_API_URL}/companies/${SLUG}/inbox/7001/file`,
      },
      {
        documentId: 7002,
        name: "Utlegg 2030-11-06 - Kari Testesen",
        filename: "2030-11-06-kari-testesen-expense-report.pdf",
        description: "Mock: generert utleggsrapport",
        status: false,
        createdAt: "2030-11-06T10:00:00Z",
        documentUrl: `${FIKEN_API_URL}/companies/${SLUG}/inbox/7002/file`,
      },
    ],
    ehf: [
      {
        ehfDocumentId: 9001,
        status: "unprocessed",
        documentType: "invoice",
        invoiceNumber: "90000000001",
        issueDate: "2030-10-29",
        dueDate: "2030-11-08",
        supplierName: "Hotel Brattøra AS",
        supplierOrganizationNumber: HOTEL_ORG,
        // The fixture's total; only shown in the list.
        gross: null as number | null,
        kid: "900000000014",
        documentUrl: `${FIKEN_API_URL}/companies/${SLUG}/ehf/9001/file`,
        createdAt: "2030-10-30T08:00:00Z",
        purchaseId: null as number | null,
      },
    ],
    contacts: [
      {
        contactId: 503,
        name: "Kari Testesen",
        email: "kari@example.com",
        customer: false,
        supplier: true,
        supplierAccountCode: "2400:20003",
        bankAccountNumber: "12345678903",
        inactive: false,
      },
      {
        contactId: 501,
        name: "Checkin AS",
        organizationNumber: CHECKIN_ORG,
        customer: true,
        supplier: true,
        customerAccountCode: "1500:10001",
        supplierAccountCode: "2400:20001",
        inactive: false,
      },
      {
        contactId: 502,
        name: "Hotel Brattøra AS",
        organizationNumber: HOTEL_ORG,
        customer: false,
        supplier: true,
        supplierAccountCode: "2400:20077",
        inactive: false,
      },
    ] as Contact[],
    bankAccounts: [
      {
        bankAccountId: 11495641085,
        name: "Driftskonto",
        accountCode: BANK,
        type: "normal",
        inactive: false,
        // Before the second payout, so the bankavstemming hint shows after booking.
        reconciledDate: "2026-03-10",
      },
      {
        bankAccountId: 12134849121,
        name: "Checkin",
        accountCode: CHECKIN,
        type: "normal",
        inactive: false,
        reconciledDate: null,
      },
    ],
    sales: [] as Record<string, unknown>[],
    purchases: [] as Record<string, unknown>[],
    saleDrafts: [] as { draftId: number; invoiceNumber: string }[],
    purchaseDrafts: [] as { draftId: number; invoiceNumber: string }[],
    journalEntries: [] as JournalEntry[],
  }
}

let state = createState()

/** Every account code in the recipe (and its ledger's base), plus the usual ones. */
function chartOfAccounts() {
  const codes = new Set(["1500", "1920", "1960", "2400", "2701", "2711", "3000", "4300"])
  const walk = (v: unknown): void => {
    if (typeof v === "string" && /^\d{4}(:\d+)?$/.test(v)) codes.add(v.slice(0, 4))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(config)
  return [...codes].sort().map((code) => ({ code, name: `Konto ${code}` }))
}

const pdf = (bytes: Uint8Array) =>
  new HttpResponse(bytes.slice().buffer, { headers: { "Content-Type": "application/pdf" } })

const created = (path: string, newId: number) =>
  new HttpResponse(null, {
    status: 201,
    headers: { Location: `${FIKEN_API_URL}/companies/${SLUG}${path}/${newId}` },
  })

const notFound = (what: string) =>
  HttpResponse.json(
    { error: "404", error_description: `No ${what} found with this id.` },
    {
      status: 404,
    },
  )

const inRange = (date: unknown, q: URLSearchParams) =>
  typeof date === "string" &&
  (!q.get("date") || date === q.get("date")) &&
  (!q.get("dateGe") || date >= (q.get("dateGe") as string)) &&
  (!q.get("dateLe") || date <= (q.get("dateLe") as string))

const query = (request: Request) => new URL(request.url).searchParams

const C = `${API_BASE}/companies/:slug`

export const handlers = [
  http.get(`${API_BASE}/user`, () =>
    HttpResponse.json({ name: "Mock Testesen", email: "mock@example.com" }),
  ),
  http.get(`${API_BASE}/companies`, () =>
    HttpResponse.json([{ name: "Trondheim Developer Conference (mock)", slug: SLUG }]),
  ),
  http.get(C, () =>
    HttpResponse.json({
      name: "Trondheim Developer Conference (mock)",
      slug: SLUG,
      organizationNumber: "999999999",
      testCompany: true,
    }),
  ),

  http.get(`${C}/accounts`, ({ request }) => {
    const range = query(request).get("range")
    const [from, to] = range?.split("-") ?? []
    return HttpResponse.json(
      chartOfAccounts().filter((a) => (!from || a.code >= from) && (!to || a.code <= to)),
    )
  }),
  http.get(`${C}/bankAccounts`, () => HttpResponse.json(state.bankAccounts)),
  http.get(`${C}/accountBalances/:code`, ({ params, request }) => {
    const code = decodeURIComponent(params.code as string)
    const date = query(request).get("date") ?? "9999-12-31"
    const balance = state.ledger
      .filter((m) => m.account === code && m.date <= date)
      .reduce((s, m) => s + m.amount, 0)
    return HttpResponse.json({ code, balance })
  }),

  http.get(`${C}/contacts`, ({ request }) => {
    const q = query(request)
    return HttpResponse.json(
      state.contacts.filter(
        (c) =>
          (!q.get("organizationNumber") || c.organizationNumber === q.get("organizationNumber")) &&
          (!q.get("email") || c.email === q.get("email")) &&
          (!q.get("name") || c.name.toLowerCase().includes(String(q.get("name")).toLowerCase())) &&
          (q.get("customer") !== "true" || c.customer) &&
          (q.get("supplier") !== "true" || c.supplier),
      ),
    )
  }),
  http.post(`${C}/contacts`, async ({ request }) => {
    const body = (await request.json()) as ContactRequest
    const contactId = state.id()
    state.contacts.push({
      contactId,
      name: body.name,
      email: body.email,
      customer: false,
      supplier: body.supplier,
      supplierAccountCode: `2400:${20000 + (contactId % 10000)}`,
      bankAccountNumber: body.bankAccountNumber,
      inactive: false,
    })
    return created("/contacts", contactId)
  }),
  http.get(`${C}/contacts/:id`, ({ params }) => {
    const contact = state.contacts.find((c) => c.contactId === Number(params.id))
    return contact ? HttpResponse.json(contact) : notFound("contact")
  }),

  http.get(`${C}/inbox`, ({ request }) => {
    const q = query(request)
    const name = q.get("name")?.toLowerCase()
    return HttpResponse.json(
      state.inbox.filter(
        (d) =>
          (q.get("status") !== "unused" || !d.status) &&
          (q.get("status") !== "used" || d.status) &&
          (!name || d.name.toLowerCase().includes(name)),
      ),
    )
  }),
  http.get(`${C}/inbox/:id/file`, ({ params }) =>
    pdf(Number(params.id) === 7002 ? UTLEGG_REPORT : MARCH_2026),
  ),
  http.get(`${C}/ehf`, () => HttpResponse.json(state.ehf)),
  http.get(`${C}/ehf/:id/file`, () => pdf(HOTEL_INVOICE)),

  http.get(`${C}/sales`, ({ request }) => {
    const q = query(request)
    return HttpResponse.json(
      state.sales.filter(
        (s) => (!q.get("saleNumber") || s.saleNumber === q.get("saleNumber")) && inRange(s.date, q),
      ),
    )
  }),
  http.get(`${C}/sales/drafts`, () => HttpResponse.json(state.saleDrafts)),
  http.get(`${C}/sales/:id`, ({ params }) => {
    const sale = state.sales.find((s) => s.saleId === Number(params.id))
    return sale ? HttpResponse.json(sale) : notFound("sale")
  }),
  http.post(`${C}/sales`, async ({ request }) => {
    const body = (await request.json()) as SaleRequest
    const saleId = state.id()
    const lines = withVat(body.lines, saleId * 10)
    const paid = body.totalPaid ?? 0
    state.sales.push({
      saleId,
      saleNumber: body.saleNumber,
      date: body.date,
      lines,
      paymentAccount: body.paymentAccount,
      salePayments: body.paymentAccount ? [{ account: body.paymentAccount, amount: paid }] : [],
    })
    if (body.paymentAccount)
      state.ledger.push({
        account: body.paymentAccount,
        date: body.paymentDate ?? body.date,
        amount: paid,
      })
    return created("/sales", saleId)
  }),

  http.get(`${C}/purchases`, ({ request }) =>
    HttpResponse.json(
      state.purchases.filter((p) => {
        const q = query(request)
        return q.get("contactId") ? p.supplierId === Number(q.get("contactId")) : inRange(p.date, q)
      }),
    ),
  ),
  http.get(`${C}/purchases/drafts`, () => HttpResponse.json(state.purchaseDrafts)),
  http.get(`${C}/purchases/:id`, ({ params }) => {
    const purchase = state.purchases.find((p) => p.purchaseId === Number(params.id))
    return purchase ? HttpResponse.json(purchase) : notFound("purchase")
  }),
  http.post(`${C}/purchases`, async ({ request }) => {
    const body = (await request.json()) as PurchaseRequest
    const purchaseId = state.id()
    const lines = withVat(body.lines, purchaseId * 10)
    const total = gross(lines)
    state.purchases.push({
      purchaseId,
      identifier: body.identifier,
      date: body.date,
      supplierId: body.supplierId,
      lines,
      paymentAccount: body.paid ? body.paymentAccount : null,
      payments:
        body.paid && body.paymentAccount ? [{ account: body.paymentAccount, amount: total }] : [],
    })
    if (body.paid && body.paymentAccount)
      state.ledger.push({
        account: body.paymentAccount,
        date: body.paymentDate ?? body.date,
        amount: -total,
      })
    return created("/purchases", purchaseId)
  }),

  http.post(`${C}/sales/drafts`, async ({ request }) => {
    const body = (await request.json()) as DraftRequest
    const draftId = state.id()
    state.saleDrafts.push({ draftId, invoiceNumber: body.invoiceNumber })
    return created("/sales/drafts", draftId)
  }),
  http.post(`${C}/purchases/drafts`, async ({ request }) => {
    const body = (await request.json()) as DraftRequest
    const draftId = state.id()
    state.purchaseDrafts.push({ draftId, invoiceNumber: body.invoiceNumber })
    return created("/purchases/drafts", draftId)
  }),
  http.post(`${C}/sales/:id/accruals`, () => created("/accruals", state.id())),
  http.post(`${C}/purchases/:id/accruals`, () => created("/accruals", state.id())),

  http.get(`${C}/journalEntries`, ({ request }) =>
    HttpResponse.json(state.journalEntries.filter((e) => inRange(e.date, query(request)))),
  ),
  // Like Fiken: the Location points at the transaction, not the journal entry.
  http.post(`${C}/generalJournalEntries`, async ({ request }) => {
    const body = (await request.json()) as GeneralJournalEntryRequest
    const transactionId = state.id()
    for (const je of body.journalEntries) {
      const lines = je.lines.flatMap((l) => [
        { account: l.debitAccount, amount: l.amount },
        { account: l.creditAccount, amount: -l.amount },
      ])
      state.journalEntries.push({
        journalEntryId: state.id(),
        transactionId,
        description: je.description,
        date: je.date,
        transactionType: "Fri",
        lines,
      })
      for (const line of lines) state.ledger.push({ ...line, date: je.date })
    }
    return created("/transactions", transactionId)
  }),
  http.get(`${C}/transactions/:id`, ({ params }) => {
    const transactionId = Number(params.id)
    const entries = state.journalEntries.filter((e) => e.transactionId === transactionId)
    return entries.length > 0
      ? HttpResponse.json({ transactionId, type: "Fri", deleted: false, entries })
      : notFound("transaction")
  }),

  // Attaching marks the inbox document or EHF as used, like Fiken does.
  http.post(`${C}/:kind/:id/attachments`, ({ params, request }) => attach(params, request)),
  http.post(`${C}/:kind/drafts/:id/attachments`, ({ params, request }) => attach(params, request)),
]

function attach(params: Record<string, unknown>, request: Request) {
  const id = Number(params.id)
  const exists =
    params.kind === "journalEntries"
      ? state.journalEntries.some((e) => e.journalEntryId === id)
      : params.kind === "sales"
        ? state.sales.some((s) => s.saleId === id) || state.saleDrafts.some((d) => d.draftId === id)
        : params.kind === "purchases"
          ? state.purchases.some((p) => p.purchaseId === id) ||
            state.purchaseDrafts.some((d) => d.draftId === id)
          : false
  if (!exists) return notFound(String(params.kind))
  const q = query(request)
  const doc = state.inbox.find((d) => d.documentId === Number(q.get("inboxDocumentId")))
  if (doc) doc.status = true
  const ehf = state.ehf.find((d) => d.ehfDocumentId === Number(q.get("ehfDocumentId")))
  if (ehf) ehf.status = "used"
  return new HttpResponse(null, { status: 201 })
}

/** Back to the start: nothing booked. */
export function resetMock() {
  state = createState()
}
