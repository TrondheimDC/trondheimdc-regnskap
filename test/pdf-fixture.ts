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

// Latin-1, one byte per character; no Buffer, so the mock mode can build these in the browser.
const byteLength = (s: string) => s.length
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)

function render(pages: Page[], info?: Record<string, string>): Uint8Array {
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
      `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`,
    ]),
  ]
  // Document info (Subject, Keywords …), as the last object, for the trailer to point at.
  if (info)
    objects.push(
      `<< ${Object.entries(info)
        .map(([k, v]) => `/${k} (${esc(v)})`)
        .join(" ")} >>`,
    )
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  const infoRef = info ? ` /Info ${objects.length} 0 R` : ""
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`
  return latin1(pdf)
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

// ---------------------------------------------------------------------------------------------
// Utleggsrapport, laid out like the PDF the utlegg form (trondheimdc-utlegg) makes: Rapportinfo,
// the table of receipts with wrapped descriptions, the total, then one page per receipt. Positions
// are the ones pdf-lib draws there.

export interface UtleggReceipt {
  description: string
  /** dd.mm.yyyy */
  date: string
  /** In the payout currency, øre; undefined prints "—" (no exchange rate). */
  amount?: number
  /** Receipt in another currency: amount in øre, currency, rate line. */
  original?: { amount: number; currency: string; rate: string }
  /** The receipt's own text lines; none for a photo. */
  text?: string[]
}

export interface UtleggData {
  name: string
  email: string
  /** "1234 56 78903", or an IBAN with `iban`. */
  account: string
  iban?: boolean
  payoutCurrency?: string
  /** dd.mm.yyyy */
  generated: string
  validationSkipped?: boolean
  receipts: UtleggReceipt[]
  /** Override the printed total, øre. */
  total?: number
  /** PDF document info, e.g. { Keywords: "utleggsrapport format-2" } as the v2 form sets it. */
  info?: { Subject?: string; Keywords?: string }
}

const nok = (ore: number) =>
  (ore / 100).toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const LONG_MONTHS = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
]

/** Splits text into lines of at most `width` characters, at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  return line ? [...lines, line] : lines
}

export function utleggPdf(data: UtleggData): Uint8Array {
  const currency = data.payoutCurrency ?? "NOK"
  const cover = new Page()
  const at = (
    page: Page,
    y: number,
    s: string,
    x: number,
    opts: { right?: boolean; size?: number } = {},
  ) => {
    page.y = y
    page.text(s, x, opts)
  }
  at(cover, 806, "Utleggsrapport", 50, { size: 24 })
  at(cover, 783, "TrondheimDC", 50, { size: 11 })
  at(cover, 724, "Rapportinfo", 50, { size: 10 })
  let y = 702
  if (data.validationSkipped) {
    at(cover, y, "ADVARSEL: Kontonummer validering ble hoppet over!", 50, { size: 12 })
    at(cover, y - 20, "Vennligst sjekk at kontonummeret er korrekt.", 50, { size: 10 })
    y -= 40
  }
  const info: [string, string][] = [
    ["Navn:", data.name],
    ["Adresse:", "Testveien 1, 7010 Trondheim, Norway"],
    ["E-post:", data.email],
    ["", "Bankinformasjon"],
    [data.iban ? "IBAN:" : "Kontonummer:", data.account],
    ["Utbetalingsvaluta:", currency],
  ]
  for (const [label, value] of info) {
    if (label) at(cover, y, label, 50, { size: 12 })
    at(cover, y, value, label ? 169 : 50, { size: label ? 12 : 10 })
    y -= 24
  }

  y -= 50
  for (const [s, x] of [
    ["#", 50],
    ["Beskrivelse", 75],
    ["Dato", 238],
    ["Valutakurs", 308],
    [`Beløp (${currency})`, 417],
  ] as const)
    at(cover, y, s, x, { size: 11 })
  at(cover, y - 12, "Norges Bank", 308, { size: 8 })
  y -= 40
  for (const [i, r] of data.receipts.entries()) {
    const description = wrap(r.description, 36)
    const exchange = r.original
      ? [`${nok(r.original.amount)} ${r.original.currency}`, r.original.rate, `Kursdato: ${r.date}`]
      : ["-"]
    at(cover, y, String(i + 1), 50, { size: 10 })
    at(cover, y, r.date, 238, { size: 10 })
    at(cover, y, r.amount === undefined ? "—" : nok(r.amount), 545, { right: true, size: 10 })
    for (const [j, line] of description.entries()) at(cover, y - j * 12, line, 75, { size: 10 })
    for (const [j, line] of exchange.entries()) at(cover, y - j * 12, line, 308, { size: 10 })
    y -= 16 + Math.max(description.length, exchange.length) * 12
  }
  const total = data.total ?? data.receipts.reduce((s, r) => s + (r.amount ?? 0), 0)
  at(cover, y - 21, `Total: ${nok(total)} ${currency}`, 545, { right: true, size: 12 })
  at(cover, 36, `Generert: ${data.generated}`, 50, { size: 9 })
  at(cover, 36, "TrondheimDC · Utleggsrapport", 546, { right: true, size: 9 })

  const receipts = data.receipts.map((r, i) => {
    const page = new Page()
    const [d, m, yyyy] = r.date.split(".")
    const header = wrap(
      `Bilag for utlegg #${i + 1}: ${r.description} (${Number(d)}. ${LONG_MONTHS[Number(m) - 1]} ${yyyy})`,
      40,
    )
    for (const [j, line] of header.entries()) at(page, 826 - j * 14, line, 50, { size: 12 })
    for (const [j, line] of (r.text ?? []).entries())
      at(page, 700 - j * 16, line, 120, { size: 10 })
    return page
  })
  return render([cover, ...receipts], data.info)
}

/** Three receipts: crew pizza (receipt says 15 %), tape (25 %), and a photo of a taxi receipt. */
export const UTLEGG_REPORT = utleggPdf({
  name: "Kari Testesen",
  email: "kari@example.com",
  account: "1234 56 78903",
  generated: "06.11.2030",
  receipts: [
    {
      description: "Pizza til crew under rigging fredag kveld, 12 stk store pizza fra Peppes",
      date: "08.10.2030",
      amount: 245050,
      text: ["Peppes Pizza", "Sum 2 450,50", "MVA 15% 319,63"],
    },
    {
      description: "Teip og kabelstrips",
      date: "09.10.2030",
      amount: 38900,
      text: ["Clas Ohlson", "Totalt 389,00", "Herav mva 25% 77,80"],
    },
    { description: "Taxi Værnes", date: "10.10.2030", amount: 51200 },
  ],
})

// ---------------------------------------------------------------------------------------------
// Utleggsrapport format 2 (trondheimdc-utlegg from November 2026, docs/pdf-format.md there):
// fields as label over value in two columns, a summary row, a table that may continue on more
// pages, and a page per receipt headed "Kvittering n av N". Positions are the generator's.

export interface UtleggV2Receipt {
  description: string
  /** dd.mm.yyyy */
  date: string
  /** Text in the Kategori column, e.g. "Reise" or "Meetup-støtte". */
  category: string
  /** In the payout currency, øre; undefined prints "—". */
  payout?: number
  /** On the receipt, when it isn't the payout currency: amount in øre and currency. */
  original?: { amount: number; currency: string; rate: string }
  /** The receipt's own text lines; none for a photo. */
  text?: string[]
}

export interface UtleggV2Data {
  reportId: string
  /** dd.mm.yyyy */
  generated: string
  /** As printed; the metadata's Author can differ (characters the font lacks print as "?"). */
  name: string
  author?: string
  email: string
  /** ["Kontonummer", "1234 56 78903"], or IBAN and BIC etc. */
  bank: [string, string][]
  currency?: string
  validationSkipped?: boolean
  receipts: UtleggV2Receipt[]
  /** Table rows per page before "Kvitteringer (forts.)". */
  rowsPerPage?: number
  /** Override "Antall kvitteringer". */
  count?: number
  /** Leave out the receipt pages of these receipts (1-based). */
  missingPages?: number[]
  /** Leave out the PDF metadata (format then known from "Rapport-ID" on page 1). */
  noMetadata?: boolean
}

export function utleggPdfV2(data: UtleggV2Data): Uint8Array {
  const currency = data.currency ?? "NOK"
  const at = (
    page: Page,
    y: number,
    s: string,
    x: number,
    opts: { right?: boolean; size?: number } = {},
  ) => {
    page.y = y
    page.text(s, x, { size: 9, ...opts })
  }
  const total = data.receipts.reduce((s, r) => s + (r.payout ?? 0), 0)
  const footer = (page: Page, n: number, of: number) => {
    at(page, 30, `Utleggsrapport ${data.reportId}`, 48, { size: 7 })
    at(page, 30, `Side ${n} av ${of}`, 547, { right: true, size: 7 })
  }

  const cover = new Page()
  at(cover, 792, "Rapport-ID", 377, { size: 7 })
  at(cover, 792, "Dato", 494, { size: 7 })
  at(cover, 779, data.reportId, 377)
  at(cover, 779, data.generated, 494)
  at(cover, 724, "Utleggsrapport", 48, { size: 24 })
  at(cover, 658, "Utlegg fra", 48, { size: 10 })
  at(cover, 658, "Utbetales til", 312, { size: 10 })
  const fields = (x: number, list: [string, string][]) => {
    let y = 634
    for (const [label, value] of list) {
      at(cover, y, label, x, { size: 7 })
      at(cover, y - 13, value, x)
      y -= 33
    }
    return y
  }
  const left = fields(48, [
    ["Navn", data.name],
    ["Adresse", "Testveien 1, 7010 Trondheim, Norge"],
    ["E-post", data.email],
  ])
  const right = fields(312, [...data.bank, ["Valuta", currency]])
  let y = Math.min(left, right)
  if (data.validationSkipped) {
    at(cover, y, "Kontonummeret er ikke validert", 60)
    at(cover, y - 13, "Personen godtok at valideringen feilet.", 60, { size: 7 })
    y -= 40
  }
  at(cover, y, "Antall kvitteringer", 64, { size: 7 })
  at(cover, y, "Periode", 188, { size: 7 })
  at(cover, y, "Sum", 531, { right: true, size: 7 })
  const dates = data.receipts.map((r) => r.date)
  at(cover, y - 19, String(data.count ?? data.receipts.length), 64)
  at(cover, y - 19, `${dates[0] ?? ""} - ${dates.at(-1) ?? ""}`, 188)
  at(cover, y - 19, `${nok(total)} ${currency}`, 531, { right: true })

  // The table, continued on more pages when it doesn't fit.
  const tablePages: Page[] = [cover]
  const perPage = data.rowsPerPage ?? 14
  const header = (page: Page, y0: number) => {
    for (const [s, x] of [
      ["#", 48],
      ["Dato", 74],
      ["Beskrivelse", 136],
      ["Kategori", 300],
    ] as const)
      at(page, y0, s, x, { size: 7 })
    at(page, y0, "Beløp", 458, { right: true, size: 7 })
    at(page, y0, `Utbetales (${currency})`, 547, { right: true, size: 7 })
  }
  at(cover, y - 65, "Kvitteringer", 48, { size: 10 })
  header(cover, y - 87)
  let page = cover
  let rowY = y - 109
  for (const [i, r] of data.receipts.entries()) {
    if (i > 0 && i % perPage === 0) {
      page = new Page()
      tablePages.push(page)
      at(page, 790, "Kvitteringer (forts.)", 48, { size: 10 })
      header(page, 768)
      rowY = 746
    }
    const lines = wrap(r.description, 36)
    const amount = r.original ?? { amount: r.payout ?? 0, currency }
    at(page, rowY, String(i + 1), 48)
    at(page, rowY, r.date, 74)
    for (const [j, line] of lines.entries()) at(page, rowY - j * 12, line, 136)
    at(page, rowY, r.category, 305)
    at(page, rowY, `${nok(amount.amount)} ${amount.currency}`, 458, { right: true })
    at(page, rowY, r.payout === undefined ? "—" : nok(r.payout), 547, { right: true })
    if (r.original) at(page, rowY - 12, r.original.rate, 458, { right: true, size: 7 })
    rowY -= 21 + (Math.max(lines.length, r.original ? 2 : 1) - 1) * 12
  }
  at(page, rowY, "Sum", 48)
  at(page, rowY, nok(total), 547, { right: true })

  const receiptPages = data.receipts.flatMap((r, i) => {
    if (data.missingPages?.includes(i + 1)) return []
    const p = new Page()
    at(p, 790, `Kvittering ${i + 1} av ${data.receipts.length}`, 48, { size: 11 })
    at(p, 791, r.category, 543, { right: true, size: 8 })
    at(p, 771, r.description, 48, { size: 10 })
    const amount = r.original ?? { amount: r.payout ?? 0, currency }
    at(p, 756, `${r.date} · ${nok(amount.amount)} ${amount.currency}`, 48, { size: 8 })
    for (const [j, line] of (r.text ?? []).entries()) at(p, 668 - j * 18, line, 128, { size: 10 })
    return [p]
  })

  const all = [...tablePages, ...receiptPages]
  for (const [i, p] of all.entries()) footer(p, i + 1, all.length)
  return render(
    all,
    data.noMetadata
      ? undefined
      : {
          Title: `Utleggsrapport ${data.reportId} - ${data.author ?? data.name}`,
          Author: data.author ?? data.name,
          Subject: "TrondheimDC utleggsrapport, format 2",
          Keywords: `utleggsrapport format-2 ${data.reportId}`,
        },
  )
}

/** Four receipts with a category each, one in USD, Norwegian account. */
export const UTLEGG_REPORT_V2 = utleggPdfV2({
  reportId: "UT-20301106-7KQ2",
  generated: "06.11.2030",
  name: "Kari Testesen",
  email: "kari@example.com",
  bank: [["Kontonummer", "1234 56 78903"]],
  receipts: [
    {
      description: "Pizza til crew under rigging fredag kveld, 12 store pizza",
      date: "09.10.2030",
      category: "Servering",
      payout: 245050,
      text: ["Peppes Pizza", "Sum 2 450,50", "Herav MVA 15% 319,63"],
    },
    {
      description: "Teip og kabelstrips til scenen",
      date: "09.10.2030",
      category: "Materiell",
      payout: 38900,
      text: ["Clas Ohlson", "Totalt 389,00", "Herav mva 25% 77,80"],
    },
    {
      description: "Taxi Værnes - Trondheim S for taler",
      date: "10.10.2030",
      category: "Reise",
      payout: 51200,
    },
    {
      description: "Meetup Pro-abonnement, 6 mnd (Meetup: Trondheim JS)",
      date: "01.10.2030",
      category: "Meetup-støtte",
      payout: 98143,
      original: { amount: 8994, currency: "USD", rate: "kurs 10,9120" },
      text: ["Total USD 89.94", "Organizer subscription"],
    },
  ],
})
