// Turns a parsed Checkin month report into the concrete Fiken requests.
// Everything here is pure so it can be printed in dry-run and unit tested.

import type { Config } from "./config.ts"
import type { OrderLine, VatType } from "./fiken.ts"

/** Amounts in øre, net (Checkin reports net amounts). */
export interface CheckinReport {
  /** "YYYY-MM" */
  month: string
  /** Ticket revenue; becomes one sale. */
  revenue: { description: string; net: number; vatType: VatType }[]
  /** Checkin fees; becomes one purchase. */
  fees: { description: string; net: number; vatType: VatType }[]
}

export interface Plan {
  month: string
  date: string
  sale: { lines: OrderLine[]; gross: number }
  purchase: { lines: OrderLine[]; gross: number }
  /** What Checkin should pay out: sale gross minus purchase gross. */
  expectedPayout: number
}

const VAT_RATES: Record<VatType, number> = {
  HIGH: 0.25,
  MEDIUM: 0.15,
  LOW: 0.12,
  NONE: 0,
  EXEMPT: 0,
  OUTSIDE: 0,
}

export function vatFor(net: number, vatType: VatType): number {
  return Math.round(net * VAT_RATES[vatType])
}

/** "2026-03" -> "2026-03-31" */
export function lastDayOfMonth(month: string): string {
  const [y, m] = parseMonth(month)
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(day).padStart(2, "0")}`
}

export function parseMonth(month: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new Error(`Invalid month "${month}", expected YYYY-MM`)
  const m = Number(match[2])
  if (m < 1 || m > 12) throw new Error(`Invalid month "${month}"`)
  return [Number(match[1]), m]
}

/** "2026-03" -> "03.2026" */
export function formatMonthNo(month: string): string {
  const [y, m] = parseMonth(month)
  return `${String(m).padStart(2, "0")}.${y}`
}

function toLines(items: CheckinReport["revenue"], account: string): OrderLine[] {
  return items
    .filter((item) => item.net !== 0)
    .map((item) => ({
      description: item.description,
      netPrice: item.net,
      vat: vatFor(item.net, item.vatType),
      vatType: item.vatType,
      account,
    }))
}

const gross = (lines: OrderLine[]) => lines.reduce((sum, l) => sum + l.netPrice + (l.vat ?? 0), 0)

export function buildPlan(report: CheckinReport, config: Config): Plan {
  const saleLines = toLines(report.revenue, config.sale.account)
  const purchaseLines = toLines(report.fees, config.purchase.account)
  if (saleLines.length === 0) throw new Error(`No revenue lines found for ${report.month}`)

  return {
    month: report.month,
    date: lastDayOfMonth(report.month),
    sale: { lines: saleLines, gross: gross(saleLines) },
    purchase: { lines: purchaseLines, gross: gross(purchaseLines) },
    expectedPayout: gross(saleLines) - gross(purchaseLines),
  }
}

export function formatNok(ore: number): string {
  return (
    (ore / 100).toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    " kr"
  )
}

/** "2026-03" -> "2026-02-28" */
export function lastDayOfPreviousMonth(month: string): string {
  const [y, m] = parseMonth(month)
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)
}
