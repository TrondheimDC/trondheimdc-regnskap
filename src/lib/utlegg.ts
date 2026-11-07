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

import { getMeta } from "unpdf"
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
  /** Category id the person chose in the form (format 2), e.g. "reise". */
  formCategory?: string
}

export interface Utleggsrapport {
  /** Version of the utlegg form that made it: 1 (before November 2026) or 2. */
  format: 1 | 2
  /** "UT-20261106-7KQ2" (format 2): unique per report, used as the purchase identifier. */
  reportId?: string
  /** "Antall kvitteringer" on page 1 (format 2), to check that no row is lost. */
  count?: number
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
  /** Where values were read: `row:3`, `total`, `name`, `bankAccount`. */
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

// Not anchored: the header can share a text cell with other text on the page (seen on a bank screenshot).
const RECEIPT_HEADER = /Bilag for utlegg #(\d+):/

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
    format: 1,
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

/** The PDF's document info, where the utlegg form names its layout version. */
export interface PdfInfo {
  Subject?: string
  Keywords?: string
  /** The person's full name in format 2, also when a character can't be shown on the page. */
  Author?: string
}

/**
 * Which version of the utlegg form made the report. From v2 on, the form puts the version in the
 * PDF's metadata ("format-2" in Keywords, "format 2" in Subject), not on the page. v1 has no
 * version and is known by its layout. Returns the version number, or undefined if this isn't an
 * utleggsrapport.
 */
export function utleggFormat(pages: Cell[][][], info: PdfInfo = {}): number | undefined {
  const tagged = /\bformat[- ](\d+)\b/i.exec(`${info.Keywords ?? ""} ${info.Subject ?? ""}`)
  if (tagged) return Number(tagged[1])
  // Without metadata (stripped on the way): format 2 is the one with a Rapport-ID on page 1.
  if ((pages[0] ?? []).flat().some((c) => c.text === "Rapport-ID")) return 2
  return looksLikeUtleggsrapport(pages) ? 1 : undefined
}

export async function pdfInfo(data: Uint8Array): Promise<PdfInfo> {
  try {
    const { info } = await getMeta(data.slice())
    const str = (v: unknown) => (typeof v === "string" ? v : undefined)
    return { Subject: str(info?.Subject), Keywords: str(info?.Keywords), Author: str(info?.Author) }
  } catch {
    return {}
  }
}

export async function parseUtleggPdf(data: Uint8Array): Promise<Utleggsrapport> {
  const [pages, info] = await Promise.all([pdfPages(data), pdfInfo(data)])
  const format = utleggFormat(pages, info)
  if (format === undefined)
    throw new Error("Dette ser ikke ut som en utleggsrapport fra utleggsskjemaet")
  if (format === 2) return parseUtleggsrapportV2(pages, info)
  if (format !== 1)
    throw new Error(
      `Utleggsrapporten er laget med en nyere versjon av skjemaet (format ${format}), som regnskap ikke leser ennå.`,
    )
  return parseUtleggsrapport(pages)
}

// ---------------------------------------------------------------------------------------------
// Format 2 (from November 2026), as described in trondheimdc-utlegg/docs/pdf-format.md.
//
// Page 1: fields as a label with the value on the line(s) below at the same x, in two columns
// ("Utlegg fra", "Utbetales til"); a summary row "Antall kvitteringer | Periode | Sum"; then
// the table # | Dato | Beskrivelse | Kategori | Beløp | Utbetales (NOK), which may continue on
// pages headed "Kvitteringer (forts.)" and ends with a "Sum" row. Every receipt page is headed
// "Kvittering n av N" with the category on the right.

/** Category text in the PDF -> category id in the recipe. */
export const FORM_CATEGORIES: Record<string, string> = {
  Reise: "reise",
  Overnatting: "overnatting",
  Servering: "servering",
  Materiell: "materiell",
  Utstyr: "utstyr",
  Programvare: "programvare",
  "Meetup-støtte": "meetup-stotte",
  Profilering: "profilering",
  Annet: "annet",
}

const V2_LABELS = new Set([
  "Rapport-ID",
  "Dato",
  "Navn",
  "Adresse",
  "E-post",
  "Kontonummer",
  "Land",
  "IBAN",
  "BIC",
  "Routingnummer",
  "Kontotype",
  "Kontonummer (utland)",
  "Bank",
  "Bankadresse",
  "Kontoinnehaver",
  "Valuta",
])

const V2_RECEIPT_HEADER = /^Kvittering (\d+) av (\d+)/
const V2_FOOTER = /^Utleggsrapport UT-|^Side \d+ av \d+$/

/** "2 450,50 NOK" -> { amount, currency } */
function amountWithCurrency(text: string): { amount: number; currency: string } | undefined {
  const m = /^(-?[\d\s.,]+)\s+([A-Z]{3})$/.exec(text.trim())
  const amount = m ? parseAmount(m[1]!) : undefined
  return m && amount !== undefined ? { amount, currency: m[2]! } : undefined
}

export function parseUtleggsrapportV2(pages: Cell[][][], info: PdfInfo = {}): Utleggsrapport {
  const first = pages[0] ?? []
  const boxes: Record<string, Box> = {}
  const mark = (key: string, c: Cell, page: number) => {
    boxes[key] = { page, x0: c.x0, x1: c.x1, y: c.y, h: c.h }
  }
  const cells = first.flat()
  const heading = cells.find((c) => c.text === "Kvitteringer")
  const summaryRow = first.find((r) => r.some((c) => c.text === "Antall kvitteringer"))
  const fieldsBottom = summaryRow?.[0]?.y ?? heading?.y ?? 0

  // Fields: walk each column (cells starting at the same x) top-down; a label starts a field and
  // the cells under it, until the next label, are its value.
  const fields = new Map<string, string>()
  const fieldCells = new Map<string, Cell>()
  const columns: Cell[][] = []
  for (const c of cells.filter((c) => c.y > fieldsBottom)) {
    const column = columns.find((col) => Math.abs(col[0]!.x0 - c.x0) < 3)
    if (column) column.push(c)
    else columns.push([c])
  }
  for (const column of columns) {
    let label: string | undefined
    for (const c of column.sort((a, b) => b.y - a.y)) {
      if (V2_LABELS.has(c.text)) {
        label = c.text
        continue
      }
      if (!label) continue
      fields.set(label, fields.has(label) ? `${fields.get(label)} ${c.text}` : c.text)
      if (!fieldCells.has(label)) fieldCells.set(label, c)
    }
  }
  const nameCell = fieldCells.get("Navn")
  if (nameCell) mark("name", nameCell, 0)
  const accountCell = fieldCells.get("Kontonummer") ?? fieldCells.get("IBAN")
  if (accountCell) mark("bankAccount", accountCell, 0)

  // Summary: the row under the labels; the count is under its label, the sum is the last cell.
  let count: number | undefined
  if (summaryRow) {
    const values = first[first.indexOf(summaryRow) + 1] ?? []
    const countLabel = summaryRow.find((c) => c.text === "Antall kvitteringer")!
    const countCell = values.find((c) => Math.abs(c.x0 - countLabel.x0) < 3)
    count = countCell && /^\d+$/.test(countCell.text) ? Number(countCell.text) : undefined
  }

  // The table, on page 1 and any "Kvitteringer (forts.)" pages before the receipts.
  const rows: UtleggRow[] = []
  let total: number | undefined
  let payoutCurrency = fields.get("Valuta") ?? "NOK"
  let done = false
  for (const [pageIndex, page] of pages.entries()) {
    if (done) break
    const headerIndex = page.findIndex((r) => r.some((c) => c.text === "Beskrivelse"))
    if (headerIndex < 0) continue
    const head = page[headerIndex]!
    const col = (name: RegExp) => head.find((c) => name.test(c.text))
    const dateCol = col(/^Dato$/)
    const descriptionCol = col(/^Beskrivelse$/)
    const categoryCol = col(/^Kategori$/)
    const amountCol = col(/^Beløp$/)
    const payoutCol = col(/^Utbetales/)
    if (!dateCol || !descriptionCol || !categoryCol || !amountCol || !payoutCol) continue
    const currency = /\(([A-Z]{3})\)/.exec(payoutCol.text)?.[1]
    if (currency) payoutCurrency = currency

    let current: UtleggRow | undefined
    for (const row of page.slice(headerIndex + 1)) {
      if (row.some((c) => V2_FOOTER.test(c.text))) continue
      const firstCell = row[0]
      if (firstCell && firstCell.x1 < dateCol.x0 && firstCell.text === "Sum") {
        const sumCell = row.find((c) => c.x1 > payoutCol.x0)
        total = sumCell ? parseAmount(sumCell.text) : undefined
        if (sumCell) mark("total", sumCell, pageIndex)
        done = true
        break
      }
      const number = firstCell && firstCell.x1 < dateCol.x0 ? /^\d+$/.exec(firstCell.text) : null
      if (number) {
        current = {
          n: Number(number[0]),
          description: "",
          date: "",
          pages: [],
          receiptRates: [],
          receiptHasText: false,
        }
        rows.push(current)
      }
      if (!current) continue
      for (const cell of number ? row.slice(1) : row) {
        // Right-aligned columns first, by where the cell ends.
        if (cell.x1 > payoutCol.x0) {
          current.amount = parseAmount(cell.text)
          mark(`row:${current.n}`, cell, pageIndex)
        } else if (cell.x1 > amountCol.x0 - 5) {
          const original = amountWithCurrency(cell.text)
          if (original) current.original = original
          // "kurs 10,9120" / "kurs mangler" under the amount: nothing to keep.
        } else if (cell.x0 >= categoryCol.x0 - 2) {
          current.formCategory = FORM_CATEGORIES[cell.text] ?? cell.text
        } else if (cell.x0 >= descriptionCol.x0 - 2) {
          current.description = `${current.description} ${cell.text}`.trim()
        } else if (cell.x0 >= dateCol.x0 - 2 && parseDate(cell.text)) {
          current.date = parseDate(cell.text)!
        }
      }
    }
  }
  // The amount column always has the receipt's currency; keep it only when it isn't the payout's.
  for (const row of rows)
    if (row.original && row.original.currency === payoutCurrency) row.original = undefined

  // Receipt pages: "Kvittering n av N", the category, the description, a "dd.mm.åååå · …" line,
  // then the receipt itself.
  for (const [i, page] of pages.entries()) {
    const n = page
      .flat()
      .map((c) => V2_RECEIPT_HEADER.exec(c.text)?.[1])
      .find(Boolean)
    const row = rows.find((r) => r.n === Number(n))
    if (!row) continue
    row.pages.push(i)
    const dateLine = page.findIndex((r) => /^\d{2}\.\d{2}\.\d{4} · /.test(r[0]?.text ?? ""))
    const receipt = page
      .slice(dateLine + 1)
      .filter((r) => !r.some((c) => V2_FOOTER.test(c.text)))
      .map((r) => r.map((c) => c.text).join(" "))
    if (receipt.some((t) => t.trim() !== "")) row.receiptHasText = true
    row.receiptRates = [
      ...new Set([...row.receiptRates, ...receiptRates(receipt.join("\n"))]),
    ].sort((a, b) => b - a)
  }

  const bank = fields.get("Kontonummer")?.replace(/\s/g, "")
  const dato = fields.get("Dato")
  return {
    format: 2,
    reportId: fields.get("Rapport-ID"),
    count,
    // The page shows "?" for characters the font lacks; the metadata has the whole name.
    name: info.Author?.trim() || (fields.get("Navn") ?? ""),
    address: fields.get("Adresse"),
    email: fields.get("E-post"),
    bankAccount: bank && /^\d{11}$/.test(bank) ? bank : undefined,
    iban: fields.get("IBAN")?.replace(/\s/g, ""),
    payoutCurrency,
    generated: dato ? parseDate(dato) : undefined,
    validationSkipped: cells.some((c) => c.text === "Kontonummeret er ikke validert"),
    rows,
    total,
    boxes,
  }
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
  /** By a rule in the recipe (index), chosen in the form (format 2), moved by the user, or none. */
  by: { rule: number } | "form" | "moved" | "none"
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
    // Format 2: the person chose the category in the form, and that is all we use. A missing or
    // unknown category stops the booking; we don't guess it from the description. Format 1 has no
    // category, so there the recipe's rules are the only way in.
    const form =
      report.format === 2 &&
      row.formCategory &&
      utlegg.categories.some((c) => c.id === row.formCategory)
        ? row.formCategory
        : undefined
    const rule =
      moved || report.format === 2
        ? -1
        : utlegg.rules.findIndex((r) => matches(r.text, row.description))
    const category = moved ?? form ?? utlegg.rules[rule]?.category
    const by = moved ? "moved" : form ? "form" : rule >= 0 ? { rule } : "none"
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
  /**
   * Purchase identifier, also used to find it again: "Utlegg UT-20261106-7KQ2 Kari Nordmann", or
   * "Utlegg 2026-11-06 Kari Nordmann" for format 1.
   */
  reference: string
  /** The last receipt's date: the claim is complete then, and no cost lands before it happened. */
  date: string
  dueDate: string
  /** The payout currency; amounts in the plan are in it. NOK, or EUR etc. for accounts abroad. */
  currency: string
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
    // Format 2 has a report id, unique per claim; format 1 only the day and the name.
    reference: `Utlegg ${report.reportId ?? report.generated ?? date} ${report.name}`.slice(0, 100),
    date,
    dueDate: addDays(
      report.generated && report.generated > date ? report.generated : date,
      utlegg.dueDays,
    ),
    currency: report.payoutCurrency,
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
