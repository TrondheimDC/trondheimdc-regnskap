// Builds PDFs laid out like Checkin's real "Regnskapsbilag" (cover page, summary page with
// Balanse / Resultat / Utbetalingsoversikt, then per-supplier details), with right-aligned
// amount columns, so the parser can be tested without committing real accounting data.

const WIDTHS: Record<string, number> = { " ": 278, ",": 278, ".": 278, "-": 333, ":": 278 }
const textWidth = (s: string, size: number) =>
  [...s].reduce((w, c) => w + (WIDTHS[c] ?? (/\d/.test(c) ? 556 : 600)), 0) * (size / 1000)

type Text = { s: string; x: number; y: number; right?: boolean; size?: number }

class Page {
  texts: Text[] = []
  y = 760
  text(s: string, x: number, opts: { right?: boolean; size?: number } = {}) {
    this.texts.push({ s, x, y: this.y, ...opts })
    return this
  }
  row(cells: [string, number][], gap = 14) {
    this.y -= gap
    for (const [i, [s, x]] of cells.entries()) this.text(s, x, { right: i > 0 })
    return this
  }
}

function render(pages: Page[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&")
  const streams = pages.map((p) =>
    p.texts
      .map(({ s, x, y, right, size = 8 }) => {
        const left = right ? x - textWidth(s, size) : x
        return `BT /F1 ${size} Tf ${left.toFixed(2)} ${y} Td (${esc(s)}) Tj ET`
      })
      .join("\n"),
  )

  // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const pageIds = pages.map((_, i) => 4 + i * 2)
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ...streams.flatMap((content, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    ]),
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"))
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, "latin1"))
}

export interface ReportData {
  period: string
  balance: [string, string, string, string][]
  result: [string, string][]
  payouts: [string, string, string, string][]
  /** Event names on the details page, e.g. "TDC 2026". */
  events?: string[]
}

export function checkinPdf(data: ReportData): Uint8Array {
  const cover = new Page()
  cover.text("Checkin AS", 40).text(data.period.split(" ")[0]!, 494).text("Periode", 435)
  cover.y -= 20
  cover.text("Regnskapsbilag", 40, { size: 16 }).text("Innhold", 298)
  cover.y -= 20
  cover.text(data.period, 40, { size: 16 }).text("Balanse .......... 2", 298)

  const summary = new Page()
  summary.text("Balanse", 40, { size: 12 })
  summary.row(
    [
      ["Konto", 40],
      ["Inngående balanse", 395],
      ["Netto endring", 475],
      ["Utgående balanse", 555],
    ],
    20,
  )
  for (const [name, a, b, c] of data.balance)
    summary.row([
      [name, 40],
      [a, 395],
      [b, 475],
      [c, 555],
    ])
  summary.y -= 30
  summary.text("Resultat", 40, { size: 12 })
  summary.row(
    [
      ["Konto", 40],
      ["Netto endring", 555],
    ],
    20,
  )
  for (const [name, a] of data.result)
    summary.row([
      [name, 40],
      [a, 555],
    ])
  summary.y -= 30
  summary.text("Utbetalingsoversikt", 40, { size: 12 })
  summary.row(
    [
      ["Konto", 40],
      ["Bokført", 398],
      ["Beløp", 555],
    ],
    20,
  )
  for (const [voucher, generated, booked, amount] of data.payouts) {
    summary.y -= 14
    summary
      .text("NO4200000000000", 40)
      .text(voucher, 155)
      .text(generated, 285)
      .text(booked, 370)
      .text(amount, 555, { right: true })
  }

  // Details page with the same accounts but other amounts; must not be read.
  const details = new Page()
  details.text("Regnskapstall for motregning", 40, { size: 12 })
  for (const event of data.events ?? [])
    details.row([
      ["Prosjekt", 40],
      [event, 300],
    ])
  details.row(
    [
      ["Konto", 40],
      ["Netto endring", 555],
    ],
    20,
  )
  details.row([
    ["4300 - Varekostnad (innenfor mva.-området)", 40],
    ["1,00", 555],
  ])
  details.row([
    ["3000 - Salgsinntekt, mva.-pliktig", 40],
    ["-99 999,00", 555],
  ])

  return render([cover, summary, details])
}

/**
 * March 2026: 49 380 net tickets (25 %), 1 234,40 Checkin fee (Checkin charged 308,65 VAT,
 * 0,05 more than 25 %), 1 512,38 transaction fee (0 %), Checkin's own accrual on 3990.
 * Net 58 669,57: 50 000 paid out (1920), 5 000 receivable (1500), 3 669,57 held (1921).
 * Checkin held 10 000 + 42 000 at the start and 15 000 + 45 669,57 at the end.
 */
export const MARCH_2026 = checkinPdf({
  period: "mars 2026",
  balance: [
    ["1500 - Kundefordringer Checkin", "10 000,00", "5 000,00", "15 000,00"],
    ["1920 - Bankinnskudd Checkin", "0,00", "50 000,00", "50 000,00"],
    ["1921 - Bankinnskudd: Checkin", "42 000,00", "3 669,57", "45 669,57"],
    ["2701 - Utgående merverdiavgift, høy sats", "-", "-12 345,00", "-12 345,00"],
    ["2711 - Inngående merverdiavgift, høy sats", "-", "308,65", "308,65"],
    ["2965 - Forskuddsbetalt inntekt", "0,00", "-49 380,00", "-49 380,00"],
  ],
  result: [
    ["3000 - Salgsinntekt, mva.-pliktig", "-49 380,00"],
    ["3990 - Periodisert salgsinntekt", "49 380,00"],
    ["4300 - Varekostnad (innenfor mva.-området)", "1 234,40"],
    ["4335 - Varekostnad (utenfor mva.-området)", "1 512,38"],
  ],
  payouts: [
    ["17342:13", "6. mar. 2026", "8. mar. 2026", "20 000,00"],
    ["17342:14", "20. mar. 2026", "22. mar. 2026", "30 000,00"],
  ],
  events: ["TDC 2026", "TDC 2026 Partnerstand"],
})

// ---------------------------------------------------------------------------------------------
// The hotel's conference invoice. Made-up numbers, bills and guests.

type Rate = 0 | 12 | 15 | 25

/** An item line. A room is `parts`: the room at 12 % and breakfast at 25 % on one line. */
export interface HotelItem {
  section: string
  /** Bill header, e.g. "NO121S0000101, Gjest Testesen, 101". */
  bill?: string
  text: string
  date: string
  parts: [Rate, number][]
  /** Line printed as a credit (Tall -1,00). */
  credit?: boolean
  /** Net and VAT as printed, instead of computing them from the parts (e.g. a round-off line). */
  printed?: { net: number; vat: number }
}

export interface HotelInvoiceData {
  number: string
  date: string
  dueDate: string
  kid: string
  supplierOrgNr?: string
  /** Detail pages: items per page. */
  pages: HotelItem[][]
  /** Overrides page-1 sums, e.g. to test a misprint: "Stay:25" -> gross in øre. */
  sectionOverrides?: Record<string, number>
}

const kr = (ore: number) => {
  const sign = ore < 0 ? "-" : ""
  const abs = Math.abs(ore)
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}${whole},${String(abs % 100).padStart(2, "0")}`
}

const netOf = (gross: number, rate: Rate) => Math.round((gross * 100) / (100 + rate))

function itemAmounts(item: HotelItem) {
  if (item.printed) return { ...item.printed, gross: item.printed.net + item.printed.vat }
  let net = 0
  let gross = 0
  for (const [rate, g] of item.parts) {
    net += netOf(g, rate)
    gross += g
  }
  return { net, vat: gross - net, gross }
}

function footer(page: Page, orgNr: string) {
  page.y = 120
  page.text("Fakturautsteder:", 42)
  page.row([
    ["Selskapsnavn:", 42],
    ["Hotel Brattøra AS", 320],
  ])
  page.row([
    ["Organisasjonsnummer:", 42],
    [orgNr, 321],
  ])
  page.row([
    ["Foretaksregisteret:", 42],
    [`NO${orgNr}MVA`, 322],
  ])
}

export function hotelInvoicePdf(data: HotelInvoiceData): Uint8Array {
  const orgNr = data.supplierOrgNr ?? "995857480"
  const items = data.pages.flat()

  // Page-1 sums per section and rate, in order of appearance.
  const sums = new Map<string, number>()
  for (const item of items)
    for (const [rate, gross] of item.parts) {
      const key = `${item.section}:${rate}`
      sums.set(key, (sums.get(key) ?? 0) + gross)
    }
  for (const [key, gross] of Object.entries(data.sectionOverrides ?? {})) sums.set(key, gross)
  const byRate = new Map<Rate, number>()
  for (const [key, gross] of sums) {
    const rate = Number(key.split(":")[1]) as Rate
    byRate.set(rate, (byRate.get(rate) ?? 0) + gross)
  }
  const total = [...byRate.values()].reduce((s, g) => s + g, 0)

  const first = new Page()
  first.text("FAKTURA", 349)
  first.row([
    ["Fakturanummer:", 349],
    [data.number, 574],
  ])
  first.row([
    ["Fakturadato:", 349],
    [data.date, 574],
  ])
  first.row([
    ["Forfallsdato:", 349],
    [data.dueDate, 574],
  ])
  first.row([
    ["Organisasjonsnummer:", 349],
    ["999999999", 574],
  ])
  first.y -= 20
  first.text("BELØP inkl. MVA:", 45).text("KID-nummer:", 164)
  first.y -= 14
  first.text(kr(total), 45).text(data.kid, 164)
  first.y -= 20
  first.row([
    ["Beskrivelse", 46],
    ["MVA %", 443],
    ["Total inkl. MVA", 572],
  ])
  for (const [key, gross] of sums) {
    const [section, rate] = key.split(":") as [string, string]
    first.row([
      [section, 46],
      [`${rate}%`, 442],
      [kr(gross), 570],
    ])
  }
  first.y -= 10
  first.text("MVA spesifikasjon", 354)
  first.row([
    ["MVA %", 354],
    ["MVA grunnlag", 501],
    ["MVA", 573],
  ])
  for (const [rate, gross] of byRate) {
    if (rate === 0) continue
    const base = netOf(gross, rate)
    first.row([
      [`${rate} %`, 354],
      [kr(base), 501],
      [kr(gross - base), 574],
    ])
  }
  first.row([
    ["Fakturatotal", 354],
    [kr(total), 574],
  ])
  footer(first, orgNr)

  const pages = data.pages.map((pageItems, i) => {
    const page = new Page()
    page.text("FAKTURA", 349)
    page.row([
      ["Fakturanummer:", 349],
      [data.number, 574],
    ])
    page.row([
      ["Spesifikasjon:", 45],
      [`Side ${i + 1} / ${data.pages.length}`, 574],
    ])
    page.row([
      ["Fakturavarer", 45],
      ["Dato", 272],
      ["Netto", 410],
      ["Mva", 462],
      ["Tall", 510],
      ["Total", 567],
    ])
    let section = i === 0 ? undefined : data.pages[i - 1]?.at(-1)?.section
    let bill = i === 0 ? undefined : data.pages[i - 1]?.at(-1)?.bill
    for (const item of pageItems) {
      if (item.section !== section) {
        page.row([[item.section, 45]])
        section = item.section
        bill = undefined
      }
      if (item.bill && item.bill !== bill) page.row([[item.bill, 54]])
      bill = item.bill
      const { net, vat, gross } = itemAmounts(item)
      page.y -= 12
      page
        .text(item.text, 62)
        .text(item.date, 250)
        .text(kr(net), 409, { right: true })
        .text(kr(vat), 462, { right: true })
        .text(item.credit ? "-1,00" : "1,00", 510, { right: true })
        .text(kr(gross), 567, { right: true })
    }
    if (i === data.pages.length - 1) {
      page.row([
        ["Fakturatotal", 49],
        [`${kr(total)} NOK`, 565],
      ])
    }
    footer(page, orgNr)
    return page
  })

  return render([first, ...pages])
}

const room = (bill: string, nights: number): HotelItem => ({
  section: "Stay",
  bill,
  text: "Stay",
  date: `18.10.2030 - ${18 + nights}.10.2030`,
  parts: [
    [12, 120000 * nights],
    [25, 15000 * nights],
  ],
})

const DAY0 = "18.10.2030"
const DAY1 = "19.10.2030"

/**
 * A conference invoice like the hotel's, made up: rooms with breakfast, a rigging day with pizza
 * and soft drinks for the crew, the conference itself, the party bill and the speakers' dinner.
 * 1 105 930 kr in total.
 */
export const HOTEL_INVOICE = hotelInvoicePdf({
  number: "90000000001",
  date: "29.10.2030",
  dueDate: "08.11.2030",
  kid: "900000000014",
  pages: [
    [
      room("NO121S0000001, GJEST TESTESEN, 101", 2),
      room("NO121S0000002, Ola Prøvesen, 102", 1),
      room("NO121S0000003, Kari Eksempel, 103", 1),
      {
        section: "Stay",
        text: "Round-off",
        date: "29.10.2030",
        parts: [],
        printed: { net: 1, vat: -1 },
      },
      {
        section: "Conference",
        bill: "NO121S0000010, NO121 BK-00001 TDC 2030",
        text: "10 x Pizza",
        date: DAY0,
        parts: [[25, 295000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000010, NO121 BK-00001 TDC 2030",
        text: "Hall A",
        date: DAY0,
        parts: [[12, 2000000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000010, NO121 BK-00001 TDC 2030",
        text: "10 x Coffee",
        date: DAY0,
        parts: [[25, 65000]],
      },
    ],
    [
      {
        section: "Conference",
        bill: "NO121S0000011, NO121 BK-00001 TDC 2030",
        text: "300 x Room Rental",
        date: DAY1,
        parts: [[12, 9000000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000011, NO121 BK-00001 TDC 2030",
        text: "STAND",
        date: DAY1,
        parts: [[12, 300000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000011, NO121 BK-00001 TDC 2030",
        text: "300 x Conference Lunch",
        date: DAY1,
        parts: [[25, 12000000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000011, NO121 BK-00001 TDC 2030",
        text: "300 x Morning Break Standard",
        date: DAY1,
        parts: [[25, 2640000]],
      },
      {
        section: "Conference",
        bill: "NO121S0000011, NO121 BK-00001 TDC 2030",
        text: "200 x Food",
        date: DAY1,
        parts: [[25, 7000000]],
      },
      {
        section: "Food & Beverage",
        bill: "NO121S0000020, NO121 BK-00001 TDC 2030",
        text: "8 x Crew food",
        date: DAY1,
        parts: [[25, 168000]],
      },
      {
        section: "Food & Beverage",
        bill: "NO121S0000021, NO121 BK-00001 TDC 2030",
        text: "Mat 230",
        date: DAY1,
        parts: [[25, -42000]],
        credit: true,
      },
      {
        section: "POS - Banquet",
        bill: "NO121S0000030, NO121 BK-00001 TDC 2030",
        text: "10 x Coca Cola 0,33",
        date: DAY0,
        parts: [[25, 65000]],
      },
      {
        section: "POS - Banquet",
        bill: "NO121S0000031, NO121 BK-00001 TDC 2030",
        text: "300 x Coca Cola Zero 0,33",
        date: DAY1,
        parts: [[25, 1950000]],
      },
      {
        section: "POS - Banquet",
        bill: "NO121S0000032, NO121 BK-00001 TDC 2030",
        text: "100 x Mexican Lager Clarion",
        date: DAY1,
        parts: [[25, 1150000]],
      },
      {
        section: "POS - Banquet",
        bill: "NO121S0000032, NO121 BK-00001 TDC 2030",
        text: "20 x Coca Cola 0,33",
        date: DAY1,
        parts: [[25, 130000]],
      },
      {
        section: "POS - Banquet",
        bill: "NO121S0000033, NO121 BK-00001 TDC 2030",
        text: "3 x Fanta 0,33",
        date: DAY1,
        parts: [[25, 19500]],
      },
      {
        section: "POS - Restaurant",
        bill: "NO121S0000040, NO121 BK-00001 TDC 2030",
        text: "20 x CHEFS CHOICE",
        date: DAY0,
        parts: [[25, 1990000]],
      },
      {
        section: "POS - Restaurant",
        bill: "NO121S0000040, NO121 BK-00001 TDC 2030",
        text: "10 x Riesling Gl",
        date: DAY0,
        parts: [[25, 205000]],
      },
      {
        section: "Fees",
        bill: "Trondheimdc",
        text: "Invoice fee",
        date: "29.10.2030",
        parts: [[12, 12000]],
      },
    ],
  ],
})
