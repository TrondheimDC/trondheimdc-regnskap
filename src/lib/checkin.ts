// Reads the Checkin "Regnskapsbilag" PDF.
//
// Page 1 is a cover page with the period ("september 2026"). The summary page (page 2) has:
// - "Balanse" (Inngående balanse | Netto endring | Utgående balanse), e.g.
//   1500 Kundefordringer, 1920 Bankinnskudd (paid out to our bank), 1921 Bankinnskudd: Checkin
//   (held by CheckinPay), 2701/2711 VAT, 2965 Forskuddsbetalt inntekt.
// - "Resultat" (Netto endring): 3000 sales (negative = credit), 3990 Checkin's own accrual,
//   4300/4335 fees.
// - "Utbetalingsoversikt": one row per payout with voucher, dates and amount.
// Later pages repeat the accounts per supplier/event with other amounts, so we only read the
// first page that has result accounts.
//
// We rebuild table rows from the text positions in the PDF and pick the amount that sits
// under the "Netto endring" header, so we don't depend on the exact column layout.

import { extractTextItems } from "unpdf"
import type { Config } from "./config.ts"
import type { CheckinReport } from "./plan.ts"

/** Checkin account -> net amount in øre, positive in the account's natural direction. */
export type Movements = Map<string, number>

export interface Payout {
  /** Checkin's voucher number, e.g. "17342:13". */
  voucher: string
  /** "Bokført" date, YYYY-MM-DD. */
  date: string
  amount: number
}

export interface ParsedReport {
  month?: string
  /** Result accounts (3000–8999). */
  movements: Movements
  /** Net movement on balance accounts (1000–2999) as printed, e.g. 2701 output VAT (negative), 1920 payouts. */
  balance: Movements
  /** Closing balance ("Utgående balanse") of the balance accounts. */
  closing: Movements
  /** Rows from "Utbetalingsoversikt". */
  payouts: Payout[]
  /**
   * Where each value was read, keyed `result:3000`, `balance:2701`, `closing:1921`, `payout:17342:13`.
   * Only filled for PDFs.
   */
  boxes: Record<string, Box>
  /** Every row on every page, cells joined by spaces. Only filled for PDFs. */
  text?: string[]
}

/**
 * Checkin's standard chart of accounts, with what each account means. Used to explain an account
 * in the report that the recipe doesn't know. Source:
 * https://www.checkinevent.com/helpcenter/regnskap-i-checkin-101-0
 */
export const CHECKIN_ACCOUNTS: Record<string, string> = {
  "1500": "Kundefordringer: salg som ikke er betalt ennå",
  "1920": "Bankinnskudd: det som er utbetalt til banken",
  "1921": "Bankinnskudd Checkin: saldoen vår hos Checkin",
  "1922": "Direktebetaling: betalt direkte til oss, ikke via Checkin",
  "2701": "Utgående mva, høy sats",
  "2704": "Utgående mva, lav sats, f.eks. mat",
  "2711": "Inngående mva, høy sats: mva på gebyrer fra Checkin",
  "2900": "Gjeld til kunde: en deltaker har betalt for mye",
  "2965": "Forskuddsbetalt inntekt: Checkins periodisering frem til arrangementet",
  "3000": "Salgsinntekt, mva-pliktig",
  "3200": "Salgsinntekt, unntatt mva",
  "3990": "Periodisert salgsinntekt: Checkins periodisering, motpost til 2965",
  "4300": "Gebyrer til Checkin med mva",
  "4335": "Gebyrer til Checkin uten mva",
  "7745": "Øreavrunding: en deltaker har betalt noen øre for mye eller for lite",
  "7770": "Internasjonalt overføringsgebyr",
  "7800": "Tap på fordringer",
  "7835": "Tap på fordringer, ikke fradragsberettiget",
}

/** "7745 (Øreavrunding: …)" when Checkin documents the account, otherwise just the number. */
export function describeCheckinAccount(account: string): string {
  const meaning = CHECKIN_ACCOUNTS[account]
  return meaning ? `${account} (${meaning})` : account
}

/** A value's rectangle on a page, in PDF units (origin bottom-left), for highlighting. */
export interface Box {
  page: number
  x0: number
  x1: number
  /** Baseline. */
  y: number
  h: number
}

interface Cell {
  text: string
  x0: number
  x1: number
  y: number
  h: number
}

const MONTHS: Record<string, number> = {
  januar: 1,
  january: 1,
  februar: 2,
  february: 2,
  mars: 3,
  march: 3,
  april: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  desember: 12,
  december: 12,
}

const SHORT_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mai: 5,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  oct: 10,
  nov: 11,
  des: 12,
  dec: 12,
}

/** Groups the text items on each PDF page into rows of cells, top to bottom. */
export async function pdfPages(data: Uint8Array): Promise<Cell[][][]> {
  // pdf.js takes ownership of (detaches) the buffer, so give it a copy.
  const { items } = await extractTextItems(data.slice())
  return items.map((pageItems) => {
    const page = pageItems.filter((i) => i.str.trim() !== "")
    const rows: { y: number; items: typeof page }[] = []
    for (const item of [...page].sort((a, b) => b.y - a.y)) {
      const row = rows.find((r) => Math.abs(r.y - item.y) <= Math.max(2, item.fontSize * 0.3))
      if (row) row.items.push(item)
      else rows.push({ y: item.y, items: [item] })
    }

    return rows.map((row) => {
      const cells: Cell[] = []
      for (const item of row.items.sort((a, b) => a.x - b.x)) {
        const last = cells.at(-1)
        // Items closer than about one character belong to the same cell, e.g. "-427" "521,63".
        if (last && item.x - last.x1 < item.fontSize * 0.8) {
          last.text += (item.x - last.x1 > item.fontSize * 0.1 ? " " : "") + item.str
          last.x1 = item.x + item.width
          last.h = Math.max(last.h, item.height || item.fontSize)
        } else {
          cells.push({
            text: item.str,
            x0: item.x,
            x1: item.x + item.width,
            y: item.y,
            h: item.height || item.fontSize,
          })
        }
      }
      for (const cell of cells) cell.text = cell.text.trim()
      return cells
    })
  })
}

/** Parses "-427 521,63", "1.234,56", "1234.56", "−100" into øre. Returns undefined if not a number. */
export function parseAmount(raw: string): number | undefined {
  let s = raw.replace(/[\s  ]|kr|NOK/gi, "").replace(/[−–]/g, "-")
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return undefined
  // The last separator is the decimal one if it occurs once and has at most two digits after it.
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."))
  const sep = s[lastSep]
  if (sep && s.split(sep).length === 2 && s.length - lastSep - 1 <= 2) {
    s = `${s.slice(0, lastSep).replace(/[.,]/g, "")}.${s.slice(lastSep + 1)}`
  } else {
    s = s.replace(/[.,]/g, "")
  }
  const value = Number(s)
  return Number.isFinite(value) ? Math.round(value * 100) : undefined
}

/** Revenue (3xxx) is shown as credit; flip it so amounts are positive. */
function naturalSign(account: string, movement: number): number {
  return account.startsWith("3") ? -movement : movement
}

const ACCOUNT_CELL = /^(\d{4})(?:\s*[-–:]\s*|\s+|$)/

/** Finds the period, e.g. "september 2026" -> "2026-09". */
export function findMonth(rows: Cell[][]): string | undefined {
  for (const cell of rows.flat()) {
    for (const m of cell.text.matchAll(/([a-zæøå]+)\s+(\d{4})/gi)) {
      const monthNumber = MONTHS[m[1]!.toLowerCase()]
      if (monthNumber) return `${m[2]}-${String(monthNumber).padStart(2, "0")}`
    }
  }
  return undefined
}

/** A month in free text, e.g. "Regnskapsbilag 2026-09" or "Regnskapsbilag september 2026" -> "2026-09". */
export function monthFromText(text: string): string | undefined {
  const iso = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}`
  for (const m of text.matchAll(/([a-zæøå]+)\s+(\d{4})/gi)) {
    const monthNumber = MONTHS[(m[1] ?? "").toLowerCase()]
    if (monthNumber) return `${m[2]}-${String(monthNumber).padStart(2, "0")}`
  }
  return undefined
}

/** "8. sep. 2026" -> "2026-09-08" */
function parseShortDate(text: string): string | undefined {
  const m = /^(\d{1,2})\.\s*([a-zæøå]+)\.?\s+(\d{4})$/i.exec(text.trim())
  const month = m && SHORT_MONTHS[m[2]!.toLowerCase().slice(0, 3)]
  if (!m || !month) return undefined
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`
}

export function parseReport(rows: Cell[][], page = 0): ParsedReport {
  const boxes: Record<string, Box> = {}
  const mark = (key: string, c: Cell) => {
    boxes[key] = { page, x0: c.x0, x1: c.x1, y: c.y, h: c.h }
  }
  const movements: Movements = new Map()
  const balance: Movements = new Map()
  const closing: Movements = new Map()
  const payouts: Payout[] = []
  let netHeader: Cell | undefined
  let closingHeader: Cell | undefined
  let inPayouts = false

  const set = (target: Movements, account: string, value: number) => {
    const existing = target.get(account)
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Konto ${account} står flere ganger i bilaget med ulike beløp (${existing / 100} og ${value / 100})`,
      )
    }
    target.set(account, value)
  }

  for (const row of rows) {
    if (row.some((c) => /^utbetalingsoversikt$/i.test(c.text))) {
      inPayouts = true
      continue
    }
    if (inPayouts) {
      // Konto | Utbetalingsbilag | Generert | Bokført | Beløp
      const voucherIndex = row.findIndex((c) => /^\d+:\d+$/.test(c.text))
      const amount = parseAmount(row.at(-1)?.text ?? "")
      const dates = row.map((c) => parseShortDate(c.text)).filter((d) => d !== undefined)
      if (voucherIndex >= 0 && amount !== undefined && dates.length > 0) {
        const voucher = row[voucherIndex]!.text
        payouts.push({ voucher, date: dates.at(-1)!, amount })
        mark(`payout:${voucher}`, row.at(-1)!)
      }
      continue
    }

    const header = row.find((c) =>
      /netto\s*(bevegelse|endring)|net\s*(movement|change)/i.test(c.text),
    )
    if (header) {
      netHeader = header
      closingHeader = row.find((c) => /utgående\s*(saldo|balanse)|closing\s*balance/i.test(c.text))
      continue
    }

    const accountIndex = row.findIndex((c) => ACCOUNT_CELL.test(c.text))
    if (accountIndex < 0) continue
    const account = ACCOUNT_CELL.exec(row[accountIndex]!.text)![1]!
    const isResult = account >= "3000" && account <= "8999"
    if (!isResult && account < "1000") continue

    const amounts = row
      .slice(accountIndex + 1)
      .map((cell) => ({ cell, amount: parseAmount(cell.text) }))
      .filter((a): a is { cell: Cell; amount: number } => a.amount !== undefined)
    if (amounts.length === 0) continue

    // Numbers are right-aligned, so pick the one whose right edge is closest to the header's.
    const under = (header: Cell) =>
      amounts.reduce((best, a) =>
        Math.abs(a.cell.x1 - header.x1) < Math.abs(best.cell.x1 - header.x1) ? a : best,
      )

    const net = netHeader ? under(netHeader) : amounts[0]!
    if (isResult) {
      set(movements, account, naturalSign(account, net.amount))
      mark(`result:${account}`, net.cell)
    } else {
      set(balance, account, net.amount)
      mark(`balance:${account}`, net.cell)
      if (closingHeader) {
        const close = under(closingHeader)
        set(closing, account, close.amount)
        mark(`closing:${account}`, close.cell)
      }
    }
  }
  return { movements, balance, closing, payouts, boxes }
}

export async function parseReportPdf(data: Uint8Array): Promise<ParsedReport> {
  const pages = await pdfPages(data)
  const month = pages.map(findMonth).find((m) => m !== undefined)
  // The summary page is the one with the "Resultat" table; detail pages repeat accounts with other amounts.
  const summaryIndex = pages.findIndex((rows) =>
    rows.some((row) => row.some((c) => /^resultat(kontoer)?$/i.test(c.text))),
  )
  const summary = pages[summaryIndex]
  const report = summary && parseReport(summary, summaryIndex)
  if (!report || report.movements.size === 0) {
    throw new Error(
      "Fant ingen resultatkontoer (3000–8999) på sammendragssiden. Er dette et regnskapsbilag fra Checkin?",
    )
  }
  const text = pages.flatMap((rows) => rows.map((row) => row.map((c) => c.text).join(" ")))
  return { ...report, month, text }
}

/** "3000=427521.63,4300=5163.44" -> movements (positive numbers, natural direction). */
export function parseAmountsArg(arg: string): Movements {
  const movements: Movements = new Map()
  for (const part of arg.split(/[,;]\s*(?=\d{4}=)/)) {
    const m = /^(\d{4})=(.+)$/.exec(part.trim())
    const amount = m ? parseAmount(m[2]!) : undefined
    if (!m || amount === undefined)
      throw new Error(`Invalid amount "${part}", expected e.g. 3000=427521.63`)
    movements.set(m[1]!, amount)
  }
  return movements
}

/**
 * Builds the Fiken lines from the recipe in the config. Checkin account numbers are only
 * used to find the amounts; every line is booked on our own Fiken account. Any amount in
 * the report that no line claims (and isn't ignored) stops the run instead of being dropped.
 */
export function toReport(month: string, movements: Movements, config: Config): CheckinReport {
  const lines = (side: Config["sale"]) =>
    side.lines.map((line) => ({
      description: line.description,
      vatType: line.vatType,
      net: line.from.reduce((sum, account) => sum + (movements.get(account) ?? 0), 0),
    }))

  const claimed = new Set(
    [...config.sale.lines, ...config.purchase.lines].flatMap((l) => l.from).concat(config.ignore),
  )
  const unclaimed = [...movements].filter(([account, net]) => net !== 0 && !claimed.has(account))
  if (unclaimed.length > 0) {
    throw new Error(
      `Bilaget har beløp på Checkin-kontoer som oppskriften ikke dekker: ` +
        `${unclaimed.map(([a, net]) => `${describeCheckinAccount(a)}: ${net / 100}`).join(", ")}. ` +
        `Legg dem til i "from" på en linje eller i "ignore" i regnskap.config.json.`,
    )
  }
  return { month, revenue: lines(config.sale), fees: lines(config.purchase) }
}
