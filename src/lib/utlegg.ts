// Reads an utleggsrapport (expense claim) made by the utlegg form (trondheimdc-utlegg) and turns
// it into one supplier purchase: the person is the supplier, and each receipt is one line.
//
// Page 1 has "Rapportinfo" (Navn:, Adresse:, E-post:, Kontonummer: or IBAN:, Utbetalingsvaluta:),
// then a table # | Beskrivelse | Dato | Valutakurs | Beløp (NOK), with "Total: … NOK" under it
// and "Generert: dd.mm.yyyy" in the footer. Long descriptions wrap onto the rows below.
// Every page after that is a receipt, headed "Bilag for utlegg #n: …". Receipts that are PDFs with
// text can say their VAT rate; photos say nothing.
//
// The report has gross amounts only. The VAT rate comes from the receipt when it can be read,
// otherwise from the category, and the user can change it per receipt in the review.
//
// Everything after reading the PDF is pure, so it can be printed in dry-run and unit tested.

import type { Box } from "./checkin.ts"
import { parseAmount, pdfPages } from "./checkin.ts"
import type { UtleggConfig, VatRate } from "./config.ts"
import type { OrderLine } from "./fiken.ts"
import { RATE_LABEL, VAT_RATES, VAT_TYPE_OF_RATE } from "./hotel.ts"
import { netFromGross } from "./plan.ts"

type Cell = Awaited<ReturnType<typeof pdfPages>>[number][number][number]

export interface UtleggRow {
  /** 1-based, as printed in the # column and in "Bilag for utlegg #n". */
  n: number
  description: string
  /** YYYY-MM-DD */
  date: string
  /** In the payout currency, øre. Undefined when the form had no exchange rate ("—"). */
  amount?: number
  /** The amount on the receipt when it was in another currency than the payout. */
  original?: { amount: number; currency: string }
  /** 0-based PDF pages with this receipt. */
  pages: number[]
  /** VAT rates the receipt names ("MVA 25 %", "15% moms"), when it has text. */
  receiptRates: VatRate[]
  /** The receipt has a text layer (a PDF, not a photo). */
  receiptHasText: boolean
}

export interface Utleggsrapport {
  name: string
  address?: string
  email?: string
  /** Norwegian account number, 11 digits. */
  bankAccount?: string
  iban?: string
  /** "NOK", or the bank country's currency for accounts abroad. */
  payoutCurrency: string
  /** The day the form made the PDF, YYYY-MM-DD. */
  generated?: string
  /** The form printed "Kontonummer validering ble hoppet over". */
  validationSkipped: boolean
  rows: UtleggRow[]
  /** "Total:" on page 1, in the payout currency. */
  total?: number
  /** Where values on page 1 were read: `row:3`, `total`, `name`, `bankAccount`. */
  boxes: Record<string, Box>
}

/** dd.mm.yyyy -> YYYY-MM-DD */
function parseDate(text: string): string | undefined {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim())
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined
}

/** Recognises the utlegg form's report: the title and the table on page 1. */
export function looksLikeUtleggsrapport(pages: Cell[][][]): boolean {
  const texts = new Set((pages[0] ?? []).flat().map((c) => c.text))
  return texts.has("Utleggsrapport") && texts.has("Rapportinfo") && texts.has("Beskrivelse")
}

const VAT_WORD = "(?:mva|moms|vat|merverdiavgift|tax)"
const RATE = "(25|15|12)(?:[.,]0+)?\\s*%"
const RATE_PATTERNS = [
  new RegExp(`${VAT_WORD}[^\\d%]{0,20}${RATE}`, "gi"),
  new RegExp(`${RATE}\\s*${VAT_WORD}`, "gi"),
]

/** VAT rates a receipt's text names, e.g. "Herav mva 25% 77,80" -> [25]. */
export function receiptRates(text: string): VatRate[] {
  const rates = new Set<VatRate>()
  for (const pattern of RATE_PATTERNS)
    for (const m of text.matchAll(pattern)) rates.add(Number(m[1]) as VatRate)
  return VAT_RATES.filter((r) => rates.has(r))
}

const RECEIPT_HEADER = /^Bilag for utlegg #(\d+):/

export function parseUtleggsrapport(pages: Cell[][][]): Utleggsrapport {
  const first = pages[0] ?? []
  const boxes: Record<string, Box> = {}
  const mark = (key: string, c: Cell) => {
    boxes[key] = { page: 0, x0: c.x0, x1: c.x1, y: c.y, h: c.h }
  }

  // Rapportinfo: "Label:" then the value; a long value wraps onto rows with no label.
  const fields = new Map<string, string>()
  const header = first.findIndex((r) => r.some((c) => c.text === "Beskrivelse"))
  let lastLabel: string | undefined
  let valueX = 0
  for (const row of first.slice(0, header < 0 ? undefined : header)) {
    const [label, ...rest] = row
    if (!label) continue
    if (/:$/.test(label.text) && rest.length > 0) {
      lastLabel = label.text.slice(0, -1)
      valueX = rest[0]!.x0
      fields.set(lastLabel, rest.map((c) => c.text).join(" "))
      if (lastLabel === "Navn") mark("name", rest[0]!)
      if (lastLabel === "Kontonummer" || lastLabel === "IBAN") mark("bankAccount", rest[0]!)
    } else if (lastLabel && Math.abs(label.x0 - valueX) < 2) {
      fields.set(lastLabel, `${fields.get(lastLabel)} ${row.map((c) => c.text).join(" ")}`)
    } else {
      lastLabel = undefined
    }
  }
  const all = first.flat().map((c) => c.text)
  const validationSkipped = all.some((t) => /validering ble hoppet over/i.test(t))
  const generated = all.map((t) => /^Generert:\s*(.+)$/.exec(t)?.[1]).find(Boolean)

  // The table: columns from the header row, then one row per receipt and its wrapped lines.
  const rows: UtleggRow[] = []
  let total: number | undefined
  let payoutCurrency = fields.get("Utbetalingsvaluta") ?? "NOK"
  if (header >= 0) {
    const head = first[header]!
    const x = (name: RegExp) => head.find((c) => name.test(c.text))?.x0
    const dateX = x(/^Dato$/) ?? Number.POSITIVE_INFINITY
    const exchangeX = x(/^Valutakurs$/) ?? Number.POSITIVE_INFINITY
    const amountHead = head.find((c) => /^Beløp/.test(c.text))
    const amountX = amountHead?.x0 ?? Number.POSITIVE_INFINITY
    const currency = /\(([A-Z]{3})\)/.exec(amountHead?.text ?? "")?.[1]
    if (currency) payoutCurrency = currency
    const descriptionX = x(/^Beskrivelse$/) ?? 0

    let current: (UtleggRow & { exchange: string[] }) | undefined
    const finish = () => {
      if (!current) return
      const { exchange, ...row } = current
      const m = /^([\d\s.,]+)\s+([A-Z]{3})$/.exec(exchange[0] ?? "")
      const amount = m ? parseAmount(m[1]!) : undefined
      if (m && amount !== undefined) row.original = { amount, currency: m[2]! }
      rows.push(row)
      current = undefined
    }
    for (const row of first.slice(header + 1)) {
      const totalCell = row.find((c) => /^Total:/.test(c.text))
      if (totalCell) {
        finish()
        const m = /^Total:\s*(.+?)\s*([A-Z]{3})?$/.exec(totalCell.text)
        total = m ? parseAmount(m[1]!) : undefined
        mark("total", totalCell)
        break
      }
      const number = row[0] && row[0].x0 < descriptionX - 1 ? /^\d+$/.exec(row[0].text) : null
      if (number) {
        finish()
        current = {
          n: Number(number[0]),
          description: "",
          date: "",
          pages: [],
          receiptRates: [],
          receiptHasText: false,
          exchange: [],
        }
      }
      if (!current) continue
      for (const cell of number ? row.slice(1) : row) {
        if (cell.x0 >= amountX - 1) {
          current.amount = parseAmount(cell.text)
          mark(`row:${current.n}`, cell)
        } else if (cell.x0 >= exchangeX - 1) {
          if (cell.text !== "-") current.exchange.push(cell.text)
        } else if (cell.x0 >= dateX - 1 && parseDate(cell.text)) {
          current.date = parseDate(cell.text)!
        } else if (cell.x0 >= descriptionX - 1) {
          current.description = `${current.description} ${cell.text}`.trim()
        }
      }
    }
    finish()
  }

  // The receipts: each page after the first is headed with the receipt it belongs to.
  for (const [i, page] of pages.entries()) {
    if (i === 0) continue
    const n = page
      .flat()
      .map((c) => RECEIPT_HEADER.exec(c.text)?.[1])
      .find(Boolean)
    const row = rows.find((r) => r.n === Number(n))
    if (!row) continue
    row.pages.push(i)
    const text = page.map((r) => r.map((c) => c.text).join(" ")).join("\n")
    // The header repeats the description and the date; a photo has nothing else on the page.
    const headerLength = `Bilag for utlegg #${row.n}: ${row.description} (30. september 2026)`
      .length
    if (text.replace(/\s/g, "").length > headerLength + 10) row.receiptHasText = true
    row.receiptRates = [...new Set([...row.receiptRates, ...receiptRates(text)])].sort(
      (a, b) => b - a,
    )
  }

  const bank = fields.get("Kontonummer")?.replace(/\s/g, "")
  return {
    name: fields.get("Navn") ?? "",
    address: fields.get("Adresse"),
    email: fields.get("E-post"),
    bankAccount: bank && /^\d{11}$/.test(bank) && !fields.has("IBAN") ? bank : undefined,
    iban: fields.get("IBAN")?.replace(/\s/g, ""),
    payoutCurrency,
    generated: generated ? parseDate(generated) : undefined,
    validationSkipped,
    rows,
    total,
    boxes,
  }
}

export async function parseUtleggPdf(data: Uint8Array): Promise<Utleggsrapport> {
  const pages = await pdfPages(data)
  if (!looksLikeUtleggsrapport(pages))
    throw new Error("Dette ser ikke ut som en utleggsrapport fra utleggsskjemaet")
  return parseUtleggsrapport(pages)
}

// ---------------------------------------------------------------------------------------------
// Categories and VAT

/** Choices in the review, keyed by receipt: "#3". */
export interface UtleggChoices {
  /** Category id per receipt. */
  moves?: Record<string, string>
  /** VAT rate per receipt. */
  rates?: Record<string, VatRate>
  /** Account per category id, overriding the recipe. */
  accounts?: Record<string, string>
}

export interface UtleggPlacement {
  row: UtleggRow
  category?: string
  /** By a rule in the recipe (index), moved by the user, or nothing matched. */
  by: { rule: number } | "moved" | "none"
  rate?: VatRate
  /**
   * Where the rate comes from: the user's choice, the receipt's text, the receipt's currency
   * (foreign: no Norwegian VAT), or the category's default. Only the first three are read; the last
   * is a guess the user confirms.
   */
  rateBy?: "choice" | "receipt" | "currency" | "category"
}

const matches = (pattern: string, text: string) => new RegExp(pattern, "i").test(text)

export function classifyUtlegg(
  report: Utleggsrapport,
  utlegg: UtleggConfig,
  choices: UtleggChoices = {},
): UtleggPlacement[] {
  return report.rows.map((row): UtleggPlacement => {
    const key = `#${row.n}`
    const moved = choices.moves?.[key]
    const rule = moved ? -1 : utlegg.rules.findIndex((r) => matches(r.text, row.description))
    const category = moved ?? utlegg.rules[rule]?.category
    const by = moved ? "moved" : rule >= 0 ? { rule } : "none"
    const defaults = utlegg.categories.find((c) => c.id === category)

    const chosen = choices.rates?.[key]
    const foreign = (row.original?.currency ?? report.payoutCurrency) !== "NOK"
    const [rate, rateBy]: [VatRate | undefined, UtleggPlacement["rateBy"]] =
      chosen !== undefined
        ? [chosen, "choice"]
        : row.receiptRates.length === 1
          ? [row.receiptRates[0], "receipt"]
          : foreign
            ? [0, "currency"]
            : defaults?.rate !== undefined
              ? [defaults.rate, "category"]
              : [undefined, undefined]
    return { row, category, by, rate, rateBy }
  })
}

// ---------------------------------------------------------------------------------------------
// The purchase

export interface UtleggPlanLine extends OrderLine {
  n: number
  category: string
  rate: VatRate
  deduct: boolean
  gross: number
}

export interface UtleggPlan {
  /** Purchase identifier, also used to find it again: "Utlegg 2026-11-06 Kari Nordmann". */
  reference: string
  /** The last receipt's date: the claim is complete then, and no cost lands before it happened. */
  date: string
  dueDate: string
  placements: UtleggPlacement[]
  lines: UtleggPlanLine[]
  gross: number
  /** Receipts without a category, a rate or an amount: they stop the booking. */
  unplaced: UtleggPlacement[]
  /** Choices naming a category the recipe doesn't have. */
  unknown: string[]
}

function deducts(deduct: boolean | VatRate[], rate: VatRate) {
  return Array.isArray(deduct) ? deduct.includes(rate) : deduct
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Line text in Fiken: "#2 Teip og kabelstrips", with the rate when it isn't deducted. */
function lineText(row: UtleggRow, rate: VatRate, deduct: boolean): string {
  const suffix = !deduct && rate !== 0 ? ` (${RATE_LABEL(rate)}, uten fradrag)` : ""
  const original = row.original ? ` (${row.original.currency})` : ""
  return (
    `#${row.n} ${row.description}`.slice(0, 200 - suffix.length - original.length) +
    original +
    suffix
  )
}

/**
 * One purchase line per receipt, on its category's account. A deducted line is booked with the
 * rate's VAT type and the net Fiken requires for the gross; a line without deduction as the gross
 * without VAT (vatType NONE), like the hotel invoice.
 */
export function buildUtleggPlan(
  report: Utleggsrapport,
  utlegg: UtleggConfig,
  choices: UtleggChoices = {},
): UtleggPlan {
  const ids = new Set(utlegg.categories.map((c) => c.id))
  const unknown = [
    ...Object.values(choices.moves ?? {}).filter((id) => !ids.has(id)),
    ...Object.keys(choices.accounts ?? {}).filter((id) => !ids.has(id)),
  ]
  const placements = classifyUtlegg(report, utlegg, choices)
  const lines: UtleggPlanLine[] = []
  const unplaced: UtleggPlacement[] = []
  for (const p of placements) {
    const category = utlegg.categories.find((c) => c.id === p.category)
    if (!category || p.rate === undefined || p.row.amount === undefined) {
      unplaced.push(p)
      continue
    }
    const gross = p.row.amount
    const deduct = p.rate !== 0 && deducts(category.deduct, p.rate)
    const net = netFromGross(gross, VAT_TYPE_OF_RATE[p.rate])
    lines.push({
      n: p.row.n,
      category: category.id,
      rate: p.rate,
      deduct,
      gross,
      description: lineText(p.row, p.rate, deduct),
      account: choices.accounts?.[category.id] ?? category.account,
      vatType: deduct ? VAT_TYPE_OF_RATE[p.rate] : "NONE",
      netPrice: deduct ? net : gross,
      vat: deduct ? gross - net : 0,
    })
  }

  const dates = report.rows
    .map((r) => r.date)
    .filter(Boolean)
    .sort()
  const date = dates.at(-1) ?? report.generated ?? ""
  return {
    reference: `Utlegg ${report.generated ?? date} ${report.name}`.slice(0, 100),
    date,
    dueDate: addDays(
      report.generated && report.generated > date ? report.generated : date,
      utlegg.dueDays,
    ),
    placements,
    lines,
    gross: lines.reduce((s, l) => s + l.gross, 0),
    unplaced,
    unknown: [...new Set(unknown)],
  }
}

/** "#2=materiell,#3=reise" -> { "#2": "materiell", ... } */
export function parseRowChoicesArg(arg: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of arg.split(",")) {
    const m = /^#?(\d+)=(.+)$/.exec(part.trim())
    if (!m) throw new Error(`Invalid choice "${part}", expected e.g. #2=materiell`)
    out[`#${m[1]}`] = m[2]!.trim()
  }
  return out
}

/** "#2=25,#3=0" -> rates per receipt. */
export function parseRatesArg(arg: string): Record<string, VatRate> {
  const out: Record<string, VatRate> = {}
  for (const [key, value] of Object.entries(parseRowChoicesArg(arg))) {
    const rate = Number(value.replace(/\s*%$/, ""))
    if (!VAT_RATES.includes(rate as VatRate))
      throw new Error(`Invalid VAT rate "${value}" for ${key}, expected 25, 15, 12 or 0`)
    out[key] = rate as VatRate
  }
  return out
}

/** Two-month VAT terms (mva-terminer): 1 = Jan–Feb … 6 = Nov–Dec. */
export function vatTerm(date: string): string {
  return `${date.slice(0, 4)}-${Math.ceil(Number(date.slice(5, 7)) / 2)}`
}
