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
