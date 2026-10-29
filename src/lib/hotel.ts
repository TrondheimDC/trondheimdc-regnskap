// Reads the conference invoice from the hotel (Hotel Brattøra AS, Clarion Hotel Trondheim) and
// turns it into one supplier purchase: a line per category and VAT rate.
//
// Page 1 has the header (number, dates, KID), the sum per section and VAT rate ("Stay 12 %",
// "Conference 25 %", …), the VAT specification and the invoice total. The pages after it list
// every item: grouped under a section ("Stay", "Conference", "POS - Banquet", …) and a bill
// ("NO121S0000032, …"), with Dato | Netto | Mva | Tall | Total. Room bills name the guest; only
// the bill number is kept.
//
// Room lines are mixed: the room is 12 % and breakfast 25 %, on the same line. They are split
// between the two rates so that the section matches the sums on page 1 exactly.
//
// Everything after reading the PDF is pure, so it can be printed in dry-run and unit tested.

import type { Box } from "./checkin.ts"
import { parseAmount, pdfPages } from "./checkin.ts"
import type { HotelConfig, VatRate } from "./config.ts"
import type { OrderLine, VatType } from "./fiken.ts"
import { netFromGross } from "./plan.ts"

export const VAT_RATES = [25, 15, 12, 0] as const satisfies VatRate[]

export const VAT_TYPE_OF_RATE: Record<VatRate, VatType> = {
  25: "HIGH",
  15: "MEDIUM",
  12: "LOW",
  0: "NONE",
}

/** "Stay" at 12 % on page 1: the gross of the section at that rate. */
export interface SectionSum {
  section: string
  rate: VatRate
  gross: number
}

/** A row of the VAT specification on page 1. */
export interface VatSpecRow {
  rate: VatRate
  base: number
  vat: number
}

export interface HotelLine {
  /** 1-based, in the order on the invoice. Shown as #12, and used to move a single line. */
  n: number
  section: string
  /** Bill (regning), e.g. "NO121S0000032". Guest names on room bills are not kept. */
  bill?: string
  /** Item text, e.g. "889 x Coca Cola Zero 0,33". Room lines are just "Stay". */
  text: string
  /** First date on the line, YYYY-MM-DD. */
  date?: string
  /** Quantity from "889 x …" in the text, negative on a credit line. Otherwise ±1. */
  count: number
  net: number
  vat: number
  gross: number
  /** The rate net and VAT give, or "mixed" for a room with breakfast. */
  rate: VatRate | "mixed"
}

export interface HotelInvoice {
  number: string
  /** Fakturadato, YYYY-MM-DD. */
  date: string
  /** Forfallsdato, YYYY-MM-DD. */
  dueDate?: string
  kid?: string
  supplierName?: string
  /** From "Foretaksregisteret: NO995857480MVA". */
  supplierOrgNr?: string
  /** "Fakturatotal" on page 1. */
  total: number
  sections: SectionSum[]
  vatSpec: VatSpecRow[]
  lines: HotelLine[]
  /** Where page-1 values were read: `section:Stay:12`, `vat:25`, `total`. */
  boxes: Record<string, Box>
}

type Cell = Awaited<ReturnType<typeof pdfPages>>[number][number][number]

/** "29.10.2026" -> "2026-10-29" */
function parseDate(text: string): string | undefined {
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined
}

/** "12%", "12 %" or "12" -> 12, if it is a rate we book. */
function parseRate(text: string): VatRate | undefined {
  const m = /^(\d{1,2})\s*%?$/.exec(text.trim())
  const rate = m ? Number(m[1]) : undefined
  return VAT_RATES.find((r) => r === rate)
}

/** The rate net and VAT give (VAT rounded per line, either from the net or the gross), or "mixed". */
export function rateOf(net: number, vat: number): VatRate | "mixed" {
  if (vat === 0) return 0
  const gross = net + vat
  for (const rate of VAT_RATES) {
    if (rate === 0) continue
    if (Math.round((net * rate) / 100) === vat || Math.round((gross * 100) / (100 + rate)) === net)
      return rate
  }
  return "mixed"
}

const BILL = /^(NO\d+S\d+)\b/

/** Recognises the hotel's invoice layout (FAKTURA with a VAT specification and item pages). */
export function looksLikeHotelInvoice(pages: Cell[][][]): boolean {
  const texts = new Set(pages.flat(2).map((c) => c.text))
  return texts.has("Fakturanummer:") && texts.has("MVA spesifikasjon") && texts.has("Fakturavarer")
}

export function parseHotelInvoice(pages: Cell[][][]): HotelInvoice {
  const first = pages[0] ?? []
  const boxes: Record<string, Box> = {}
  const mark = (key: string, c: Cell) => {
    boxes[key] = { page: 0, x0: c.x0, x1: c.x1, y: c.y, h: c.h }
  }
  const fieldValue = (label: string) => {
    const row = first.find((r) => r[0]?.text === label || r.some((c) => c.text === label))
    const i = row?.findIndex((c) => c.text === label) ?? -1
    return row && i >= 0 ? row[i + 1]?.text : undefined
  }
  /** A value printed below its label, e.g. "KID-nummer:" with the number on the next row. */
  const below = (label: string) => {
    for (const [i, row] of first.entries()) {
      const cell = row.find((c) => c.text === label)
      if (cell) return first[i + 1]?.find((c) => Math.abs(c.x0 - cell.x0) < 4)?.text
    }
    return undefined
  }

  const number = fieldValue("Fakturanummer:")
  const date = parseDate(fieldValue("Fakturadato:") ?? "")
  if (!number || !date)
    throw new Error("Fant ikke fakturanummer og fakturadato. Er dette fakturaen fra hotellet?")

  const sections: SectionSum[] = []
  const vatSpec: VatSpecRow[] = []
  let total: number | undefined
  let part: "none" | "sections" | "vat" = "none"
  for (const row of first) {
    const texts = row.map((c) => c.text)
    if (texts.includes("Beskrivelse") && texts.includes("MVA %")) {
      part = "sections"
      continue
    }
    if (texts.includes("MVA spesifikasjon")) {
      part = "vat"
      continue
    }
    if (texts[0] === "Fakturatotal" && total === undefined) {
      const cell = row.at(-1)
      total = cell && parseAmount(cell.text)
      if (cell && total !== undefined) mark("total", cell)
      part = "none"
      continue
    }
    if (part === "sections" && row.length === 3) {
      const [name, rateCell, amountCell] = row as [Cell, Cell, Cell]
      const rate = parseRate(rateCell.text)
      const gross = parseAmount(amountCell.text)
      if (rate === undefined || gross === undefined) continue
      sections.push({ section: name.text, rate, gross })
      mark(`section:${name.text}:${rate}`, amountCell)
    }
    if (part === "vat" && row.length === 3) {
      const [rateCell, baseCell, vatCell] = row as [Cell, Cell, Cell]
      const rate = parseRate(rateCell.text)
      const base = parseAmount(baseCell.text)
      const vat = parseAmount(vatCell.text)
      if (rate === undefined || base === undefined || vat === undefined) continue
      vatSpec.push({ rate, base, vat })
      mark(`vat:${rate}`, vatCell)
    }
  }
  if (sections.length === 0 || total === undefined)
    throw new Error("Fant ikke summene per seksjon og mva-sats på side 1 av fakturaen")

  const sectionNames = new Set(sections.map((s) => s.section))
  const lines: HotelLine[] = []
  let section = ""
  let bill: string | undefined
  for (const rows of pages.slice(1)) {
    let inItems = false
    for (const row of rows) {
      const texts = row.map((c) => c.text)
      if (texts[0] === "Fakturavarer") {
        inItems = true
        continue
      }
      if (!inItems) continue
      if (texts[0] === "Fakturatotal" || texts[0] === "Fakturautsteder:") break
      if (row.length === 1) {
        const text = texts[0] ?? ""
        if (sectionNames.has(text)) {
          section = text
          bill = undefined
        } else {
          // Only the bill number: room bills go on with the guest's name and room.
          const m = BILL.exec(text)
          if (m) bill = m[1]
        }
        continue
      }
      const dateIndex = row.findIndex((c) => parseDate(c.text) !== undefined)
      if (dateIndex < 1) continue
      const amounts = row.slice(dateIndex + 1).map((c) => parseAmount(c.text))
      if (amounts.length !== 4 || amounts.some((a) => a === undefined)) continue
      const [net, vat, quantity, gross] = amounts as [number, number, number, number]
      const text = texts.slice(0, dateIndex).join(" ")
      const counted = /^(\d+)\s*x\s/i.exec(text)
      const sign = quantity < 0 ? -1 : 1
      lines.push({
        n: lines.length + 1,
        section,
        bill,
        text,
        date: parseDate(texts[dateIndex] ?? ""),
        count: sign * (counted ? Number(counted[1]) : 1),
        net,
        vat,
        gross,
        rate: rateOf(net, vat),
      })
    }
  }
  if (lines.length === 0) throw new Error("Fant ingen varelinjer på sidene etter side 1")

  const issuer = first.flat().find((c) => /^NO\d{9}MVA$/.test(c.text))
  const name = fieldValue("Selskapsnavn:")
  return {
    number,
    date,
    dueDate: parseDate(fieldValue("Forfallsdato:") ?? ""),
    kid: below("KID-nummer:")?.replace(/\s/g, "") || undefined,
    supplierName: name,
    supplierOrgNr: issuer?.text.slice(2, 11),
    total,
    sections,
    vatSpec,
    lines,
    boxes,
  }
}

export async function parseHotelInvoicePdf(data: Uint8Array): Promise<HotelInvoice> {
  const pages = await pdfPages(data)
  if (!looksLikeHotelInvoice(pages))
    throw new Error("Dette ser ikke ut som en faktura fra hotellet (fant ikke mva-spesifikasjon)")
  return parseHotelInvoice(pages)
}

// ---------------------------------------------------------------------------------------------
// Splitting room lines between 12 % and 25 %

/** A line's gross per VAT rate. A room line has two parts, every other line one. */
export interface LinePart {
  rate: VatRate
  gross: number
}

export interface SectionSplit {
  section: string
  /** Gross per rate from splitting each mixed line by its net and VAT, before evening out. */
  computed: Partial<Record<VatRate, number>>
  /** The same from page 1. */
  printed: Partial<Record<VatRate, number>>
}

export interface Split {
  /** Parts per line number. */
  parts: Map<number, LinePart[]>
  /** Sections with mixed lines and how far the per-line split was from page 1. */
  sections: SectionSplit[]
  /** Mixed lines that can't be split, e.g. in a section without exactly two rates on page 1. */
  unsplit: HotelLine[]
}

/**
 * Splits each line into gross per rate. A mixed line (room + breakfast) is split algebraically:
 * with net N and VAT V across a low and a high rate, the high net is (V − low·N) / (high − low).
 * Rounding per line leaves the section a few øre off page 1; the difference goes on the largest
 * mixed line, so every section matches page 1 exactly. `sections` keeps the difference for the checks.
 */
export function splitLines(invoice: HotelInvoice): Split {
  const parts = new Map<number, LinePart[]>()
  const unsplit: HotelLine[] = []
  const splits: SectionSplit[] = []

  const ratesOf = (section: string) =>
    invoice.sections
      .filter((s) => s.section === section)
      .map((s) => s.rate)
      .sort((a, b) => a - b)

  const mixedBySection = new Map<string, HotelLine[]>()
  for (const line of invoice.lines) {
    if (line.gross === 0) {
      // Round-off lines: 0 kr, but net and VAT moved between each other.
      parts.set(line.n, [])
    } else if (line.rate !== "mixed") {
      parts.set(line.n, [{ rate: line.rate, gross: line.gross }])
    } else {
      const list = mixedBySection.get(line.section) ?? []
      list.push(line)
      mixedBySection.set(line.section, list)
    }
  }

  for (const [section, mixed] of mixedBySection) {
    const rates = ratesOf(section)
    if (rates.length !== 2) {
      unsplit.push(...mixed)
      for (const line of mixed) parts.set(line.n, [])
      continue
    }
    const [low, high] = rates as [VatRate, VatRate]
    for (const line of mixed) {
      const highNet = (100 * line.vat - low * line.net) / (high - low)
      const highGross = Math.round((highNet * (100 + high)) / 100)
      parts.set(line.n, [
        { rate: low, gross: line.gross - highGross },
        { rate: high, gross: highGross },
      ])
    }

    const sumAt = (rate: VatRate) =>
      invoice.lines
        .filter((l) => l.section === section)
        .flatMap((l) => parts.get(l.n) ?? [])
        .filter((p) => p.rate === rate)
        .reduce((s, p) => s + p.gross, 0)
    const printedAt = (rate: VatRate) =>
      invoice.sections.find((s) => s.section === section && s.rate === rate)?.gross ?? 0
    const computed = { [low]: sumAt(low), [high]: sumAt(high) }
    const printed = { [low]: printedAt(low), [high]: printedAt(high) }
    splits.push({ section, computed, printed })

    // Even out on the largest mixed line, but only when the section total matches; otherwise
    // the checks show the difference as it is.
    const diff = printedAt(high) - sumAt(high)
    const sectionMatches = sumAt(low) + sumAt(high) === printedAt(low) + printedAt(high)
    const largest = [...mixed].sort((a, b) => b.gross - a.gross)[0]
    const largestParts = largest && parts.get(largest.n)
    if (diff !== 0 && sectionMatches && largestParts) {
      const [lowPart, highPart] = largestParts as [LinePart, LinePart]
      parts.set(largest.n, [
        { rate: low, gross: lowPart.gross - diff },
        { rate: high, gross: highPart.gross + diff },
      ])
    }
  }
  return { parts, sections: splits, unsplit }
}

// ---------------------------------------------------------------------------------------------
// Categories

/** Where the user moved a bill or a line: key is a bill number or "#12", value a category id. */
export type Moves = Record<string, string>

export interface Placement {
  line: HotelLine
  /** Category id, or undefined when no rule or move places the line. */
  category?: string
  /** How: by a rule in the recipe (index), or moved by the user, as a bill or a single line. */
  by: { rule: number } | "bill" | "line" | "none"
}

const matches = (pattern: string | undefined, text: string) =>
  pattern === undefined || new RegExp(pattern, "i").test(text)

/**
 * Proposes a category per line from the recipe's rules (the first that matches wins), then applies
 * the user's moves: a line moved on its own wins over its bill. Lines nothing places stay without a
 * category and stop the booking.
 */
export function classify(invoice: HotelInvoice, hotel: HotelConfig, moves: Moves = {}) {
  const billLines = (bill: string | undefined) =>
    bill ? invoice.lines.filter((l) => l.bill === bill) : []
  return invoice.lines.map((line): Placement => {
    const lineMove = moves[`#${line.n}`]
    if (lineMove) return { line, category: lineMove, by: "line" }
    const billMove = line.bill ? moves[line.bill] : undefined
    if (billMove) return { line, category: billMove, by: "bill" }
    const rule = hotel.rules.findIndex(
      (r) =>
        (r.section === undefined || r.section.toLowerCase() === line.section.toLowerCase()) &&
        (r.rate === undefined || r.rate === line.rate) &&
        matches(r.text, line.text) &&
        (r.billText === undefined ||
          billLines(line.bill).some((l) => matches(r.billText, l.text))) &&
        (r.minCount === undefined || Math.abs(line.count) >= r.minCount) &&
        (r.maxCount === undefined || Math.abs(line.count) <= r.maxCount),
    )
    const found = hotel.rules[rule]
    return found
      ? { line, category: found.category, by: { rule } }
      : { line, category: undefined, by: "none" }
  })
}

// ---------------------------------------------------------------------------------------------
// The purchase

export interface HotelPlanLine extends OrderLine {
  category: string
  rate: VatRate
  /** Input VAT is deducted; otherwise the gross is booked without VAT. */
  deduct: boolean
  gross: number
  /** The VAT on the invoice for this gross, also when it isn't deducted. */
  invoiceVat: number
}

export interface HotelPlan {
  /** The invoice number, used as the purchase identifier and to find it again. */
  reference: string
  date: string
  dueDate?: string
  kid?: string
  placements: Placement[]
  split: Split
  lines: HotelPlanLine[]
  gross: number
  /** Lines without a category: they stop the booking. */
  unplaced: HotelLine[]
  /** Moves or account choices naming a category the recipe doesn't have. */
  unknown: string[]
}

export interface HotelChoices {
  moves?: Moves
  /** Account per category id, overriding the recipe (e.g. picked from Fiken's chart of accounts). */
  accounts?: Record<string, string>
}

export const RATE_LABEL = (rate: VatRate) => (rate === 0 ? "uten mva" : `${rate} % mva`)

function deducts(deduct: boolean | VatRate[], rate: VatRate) {
  return Array.isArray(deduct) ? deduct.includes(rate) : deduct
}

/**
 * One purchase line per category and VAT rate, in the recipe's order. A deducted line is booked
 * with the rate's VAT type and the net Fiken requires for the gross; a line without deduction is
 * booked as the gross without VAT (vatType NONE), since Fiken has no domestic "without deduction"
 * type for purchases.
 */
export function buildHotelPlan(
  invoice: HotelInvoice,
  hotel: HotelConfig,
  choices: HotelChoices = {},
): HotelPlan {
  const moves = choices.moves ?? {}
  const ids = new Set(hotel.categories.map((c) => c.id))
  const unknown = [
    ...Object.values(moves).filter((id) => !ids.has(id)),
    ...Object.keys(choices.accounts ?? {}).filter((id) => !ids.has(id)),
  ]
  const placements = classify(invoice, hotel, moves)
  const split = splitLines(invoice)

  const sums = new Map<string, number>()
  for (const p of placements) {
    if (!p.category || !ids.has(p.category)) continue
    for (const part of split.parts.get(p.line.n) ?? []) {
      const key = `${p.category}:${part.rate}`
      sums.set(key, (sums.get(key) ?? 0) + part.gross)
    }
  }

  const lines: HotelPlanLine[] = []
  for (const category of hotel.categories) {
    const rates = VAT_RATES.filter((r) => sums.has(`${category.id}:${r}`))
    for (const rate of rates) {
      const gross = sums.get(`${category.id}:${rate}`) ?? 0
      if (gross === 0) continue
      const deduct = rate !== 0 && deducts(category.deduct, rate)
      const net = netFromGross(gross, VAT_TYPE_OF_RATE[rate])
      const text =
        category.lineText?.[String(rate) as `${VatRate}`] ??
        [
          category.label,
          rates.length > 1 && RATE_LABEL(rate),
          !deduct && rate !== 0 && "uten fradrag",
        ]
          .filter(Boolean)
          .join(", ")
      lines.push({
        category: category.id,
        rate,
        deduct,
        gross,
        invoiceVat: gross - net,
        description: text,
        account: choices.accounts?.[category.id] ?? category.account,
        vatType: deduct ? VAT_TYPE_OF_RATE[rate] : "NONE",
        netPrice: deduct ? net : gross,
        vat: deduct ? gross - net : 0,
      })
    }
  }

  return {
    reference: invoice.number,
    date: invoice.date,
    dueDate: invoice.dueDate,
    kid: invoice.kid,
    placements,
    split,
    lines,
    gross: lines.reduce((s, l) => s + l.gross, 0),
    unplaced: placements
      .filter((p) => !p.category || !ids.has(p.category))
      .filter((p) => p.line.gross !== 0)
      .map((p) => p.line),
    unknown: [...new Set(unknown)],
  }
}

/** A bill on the invoice with the lines in it, for showing and moving whole bills. */
export interface BillGroup {
  /** Bill number, or `#12` for a line without a bill. */
  key: string
  bill?: string
  section: string
  placements: Placement[]
  gross: number
}

/** Placements grouped by bill, in invoice order. Lines without a bill are their own group. */
export function groupByBill(placements: Placement[]): BillGroup[] {
  const groups: BillGroup[] = []
  for (const p of placements) {
    const key = p.line.bill ?? `#${p.line.n}`
    const last = groups.at(-1)
    const group = last?.key === key ? last : groups.find((g) => g.key === key && g.bill)
    if (group) {
      group.placements.push(p)
      group.gross += p.line.gross
    } else {
      groups.push({
        key,
        bill: p.line.bill,
        section: p.line.section,
        placements: [p],
        gross: p.line.gross,
      })
    }
  }
  return groups
}

/** "NO121S0000033=crew,#57=servering" -> moves. */
export function parseMovesArg(arg: string): Moves {
  const moves: Moves = {}
  for (const part of arg.split(",")) {
    const [, key, category] = /^\s*(#\d+|NO\d+S\d+)\s*=\s*([a-z][a-z0-9-]*)\s*$/i.exec(part) ?? []
    if (!key || !category)
      throw new Error(`Ugyldig flytting "${part}", skriv f.eks. NO121S0000033=crew eller #57=crew`)
    moves[key.toUpperCase()] = category
  }
  return moves
}

/** "crew=5990,lokaler=6300" -> account per category. */
export function parseAccountsArg(arg: string): Record<string, string> {
  const accounts: Record<string, string> = {}
  for (const part of arg.split(",")) {
    const [, category, account] = /^\s*([a-z][a-z0-9-]*)\s*=\s*(\d{4})\s*$/i.exec(part) ?? []
    if (!category || !account) throw new Error(`Ugyldig konto "${part}", skriv f.eks. crew=5990`)
    accounts[category] = account
  }
  return accounts
}
