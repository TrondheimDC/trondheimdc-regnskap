// Numbered highlights tying each amount on the review screen to where it was read in the PDF.

import type { Prepared } from "./booking.ts"
import type { Box } from "./checkin.ts"
import type { Config } from "./config.ts"
import type { VatType } from "./fiken.ts"
import type { HotelInvoice } from "./hotel.ts"
import { type BookedLine, effectiveVatType } from "./verify.ts"

export type MarkKind = "sale" | "purchase" | "vat" | "payout" | "check" | "ignored"

export interface Mark {
  /** 1-based, in the order the amounts appear on the review screen. */
  n: number
  /** Box key from the parser, e.g. `result:3000`. */
  key: string
  kind: MarkKind
  box: Box
  /** What the number is, e.g. "Checkin 3000". */
  label: string
  /** Amount as printed in the PDF. */
  amount: number
}

export const MARK_KINDS: Record<MarkKind, { label: string; color: string }> = {
  sale: { label: "Salg", color: "#4ade80" },
  purchase: { label: "Kjøp / gebyr", color: "#fbbf24" },
  vat: { label: "Mva", color: "#a78bfa" },
  payout: { label: "Utbetaling", color: "#38bdf8" },
  check: { label: "Kontroll", color: "#f472b6" },
  ignored: { label: "Ignoreres", color: "#a1a1aa" },
}

export const lineKeys = (config: Config, side: "sale" | "purchase", description: string) =>
  config[side].lines
    .filter((l) => l.description === description)
    .flatMap((l) => l.from.map((a) => `result:${a}`))

export const vatKey = (config: Config, side: "sale" | "purchase", vatType: VatType) => {
  const account = (side === "sale" ? config.reconcile.outputVat : config.reconcile.inputVat)[
    vatType
  ]
  return account ? `balance:${account}` : undefined
}

/**
 * Box keys for a line as booked in Fiken: those of the bilag line with the same account and VAT
 * type, the way the audit pairs them. None if the line has no match in the bilag.
 */
export function bookedLineKeys(
  config: Config,
  plan: Prepared["plan"],
  side: "sale" | "purchase",
  line: BookedLine,
) {
  const vatType = effectiveVatType(line)
  const match = plan[side].lines.find((l) => l.account === line.account && l.vatType === vatType)
  if (!match) return { net: [], vat: undefined }
  return {
    net: lineKeys(config, side, match.description),
    vat: line.vat ? vatKey(config, side, match.vatType) : undefined,
  }
}

export const payoutKey = (voucher: string) => `payout:${voucher}`

/** Checkin's own figures the checks compare against: paid out, net change and closing balance. */
export function checkKeys(config: Config) {
  const { payoutAccounts, balanceAccounts = [] } = config.reconcile
  return [
    ...payoutAccounts.map((a) => ({ key: `balance:${a}`, label: `${a} netto endring` })),
    ...balanceAccounts.map((a) => ({ key: `balance:${a}`, label: `${a} netto endring` })),
    ...balanceAccounts.map((a) => ({ key: `closing:${a}`, label: `${a} utgående balanse` })),
  ]
}

export function buildMarks({ plan, source, transfers }: Prepared, config: Config): Mark[] {
  const marks: Mark[] = []
  const amountOf = (key: string): number | undefined => {
    const [kind, ...rest] = key.split(":")
    const id = rest.join(":")
    if (kind === "result") {
      const v = source.movements.get(id)
      return v === undefined ? undefined : id.startsWith("3") ? -v : v
    }
    if (kind === "balance") return source.balance.get(id)
    if (kind === "closing") return source.closing.get(id)
    if (kind === "payout") return source.payouts.find((p) => p.voucher === id)?.amount
    return undefined
  }
  const add = (key: string | undefined, kind: MarkKind, label: string) => {
    if (!key || marks.some((m) => m.key === key)) return
    const box = source.boxes[key]
    const amount = amountOf(key)
    if (box && amount !== undefined)
      marks.push({ n: marks.length + 1, key, kind, box, label, amount })
  }

  for (const side of ["sale", "purchase"] as const) {
    for (const line of plan[side].lines) {
      for (const key of lineKeys(config, side, line.description))
        add(key, side, `Checkin ${key.slice("result:".length)}`)
      const vat = vatKey(config, side, line.vatType)
      if (line.vat) add(vat, "vat", `Mva ${vat?.slice("balance:".length)}`)
    }
  }
  for (const t of transfers) add(payoutKey(t.voucher), "payout", `Bilag ${t.voucher}`)
  for (const { key, label } of checkKeys(config)) add(key, "check", label)
  for (const account of config.ignore) {
    add(`result:${account}`, "ignored", `${account} ignoreres`)
    add(`balance:${account}`, "ignored", `${account} ignoreres`)
  }
  return marks
}

/** Marks on page 1 of the hotel invoice: the sums per section and rate, the VAT and the total. */
export function buildHotelMarks(invoice: HotelInvoice): Mark[] {
  const marks: Mark[] = []
  const add = (key: string, kind: MarkKind, label: string, amount: number) => {
    const box = invoice.boxes[key]
    if (box) marks.push({ n: marks.length + 1, key, kind, box, label, amount })
  }
  for (const s of invoice.sections)
    add(`section:${s.section}:${s.rate}`, "purchase", `${s.section} ${s.rate} %`, s.gross)
  for (const v of invoice.vatSpec) add(`vat:${v.rate}`, "vat", `Mva ${v.rate} %`, v.vat)
  add("total", "check", "Fakturatotal", invoice.total)
  return marks
}
