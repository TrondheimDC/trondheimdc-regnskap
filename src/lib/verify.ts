// Cross-checks the computed Fiken lines against other numbers in the same Checkin report,
// so a misread PDF or a wrong account mapping shows up before anything is booked.

import type { Movements, Payout } from "./checkin.ts"
import type { VatType } from "./fiken.ts"
import { formatNok, type Plan } from "./plan.ts"

/** Checkin rounds VAT per ticket, we round per line, so allow a little drift. */
const TOLERANCE_ORE = 100

export interface Check {
  label: string
  /** What we compute or what Fiken has. */
  expected: number
  /** What the Checkin report says. */
  actual: number
  ok: boolean
  /** Name for `expected` when printed, e.g. "beregnet" or "Fiken". */
  source?: string
  /** Hint shown when the check fails. */
  hint?: string
}

function vatByType(lines: Plan["sale"]["lines"]): Map<VatType, number> {
  const sums = new Map<VatType, number>()
  for (const l of lines) sums.set(l.vatType, (sums.get(l.vatType) ?? 0) + (l.vat ?? 0))
  return sums
}

/** Checkin VAT accounts per VAT type; output VAT is printed as negative (credit). */
export interface VatAccounts {
  outputVat: Partial<Record<VatType, string>>
  inputVat: Partial<Record<VatType, string>>
}

export function verifyPlan(plan: Plan, balance: Movements, vatAccounts: VatAccounts): Check[] {
  const checks: Check[] = []
  const add = (label: string, expected: number, actual: number) =>
    checks.push({ label, expected, actual, ok: Math.abs(expected - actual) <= TOLERANCE_ORE })

  const saleVat = vatByType(plan.sale.lines)
  for (const [vatType, account] of Object.entries(vatAccounts.outputVat) as [VatType, string][]) {
    const reported = balance.get(account)
    if (reported === undefined) continue
    add(`Utgående mva ${vatType} mot Checkin ${account}`, saleVat.get(vatType) ?? 0, -reported)
  }

  const purchaseVat = vatByType(plan.purchase.lines)
  for (const [vatType, account] of Object.entries(vatAccounts.inputVat) as [VatType, string][]) {
    const reported = balance.get(account)
    if (reported === undefined) continue
    add(`Inngående mva ${vatType} mot Checkin ${account}`, purchaseVat.get(vatType) ?? 0, reported)
  }
  return checks
}

export interface FikenCheckinAccount {
  code: string
  /** Balance at the end of the previous month. */
  start: number
  /** Balance at the end of the report month, before this report is booked. */
  end: number
}

/**
 * Reconciles our Checkin account in Fiken (e.g. 1960:10001) against the report, counting what
 * this run will book (`newTransfers`: payouts not yet moved to the bank in Fiken):
 * - money moved out of the account this month (already in Fiken + new fri posteringer) must equal
 *   what Checkin paid out to our bank, and
 * - optionally, the balance after booking must equal what Checkin says it holds for us.
 */
export function reconcile(
  plan: Plan,
  report: { balance: Movements; closing: Movements; payouts: Payout[] },
  fiken: FikenCheckinAccount,
  config: { payoutAccounts: string[]; balanceAccounts?: string[] },
  newTransfers = 0,
): Check[] {
  const checks: Check[] = []
  const sum = (accounts: string[], from: Movements) =>
    accounts.some((a) => from.has(a))
      ? accounts.reduce((s, a) => s + (from.get(a) ?? 0), 0)
      : undefined

  const paidOut = sum(config.payoutAccounts, report.balance)
  if (paidOut !== undefined) {
    const movedOut = fiken.start - fiken.end + newTransfers
    checks.push({
      label: `Utbetalt til bank: Checkin ${config.payoutAccounts.join("+")} mot overført fra ${fiken.code} i Fiken`,
      expected: movedOut,
      actual: paidOut,
      ok: movedOut === paidOut,
      source: "Fiken",
      hint: "Noe annet er ført på Checkin-kontoen denne måneden, eller en utbetaling er ført med feil beløp eller dato.",
    })
  }

  if (config.balanceAccounts) {
    const held = sum(config.balanceAccounts, report.closing)
    if (held !== undefined) {
      const after = fiken.end + plan.sale.gross - plan.purchase.gross - newTransfers
      checks.push({
        label: `Saldo etter føring: ${fiken.code} i Fiken mot Checkin ${config.balanceAccounts.join("+")}`,
        expected: after,
        actual: held,
        ok: Math.abs(after - held) <= TOLERANCE_ORE,
        source: "Fiken etter føring",
      })
    }
  }
  return checks
}

/** The payouts listed in "Utbetalingsoversikt" must add up to the net movement on the payout accounts. */
export function verifyPayoutList(
  report: { balance: Movements; payouts: Payout[] },
  payoutAccounts: string[],
): Check[] {
  if (report.payouts.length === 0 || !payoutAccounts.some((a) => report.balance.has(a))) return []
  const listed = report.payouts.reduce((s, p) => s + p.amount, 0)
  const paidOut = payoutAccounts.reduce((s, a) => s + (report.balance.get(a) ?? 0), 0)
  return [
    {
      label: `Utbetalingsoversikten (${report.payouts.length} stk) mot Checkin ${payoutAccounts.join("+")}`,
      expected: listed,
      actual: paidOut,
      ok: listed === paidOut,
      source: "sum",
    },
  ]
}

/**
 * Sales minus fees (incl. VAT) must equal what Checkin shows as the money's destination:
 * still held or receivable (balanceAccounts, e.g. 1500 + 1921) plus paid out (payoutAccounts, 1920).
 * This proves every amount on the sale and purchase was read and mapped correctly.
 */
export function verifyNet(
  plan: Plan,
  balance: Movements,
  accounts: { payoutAccounts: string[]; balanceAccounts?: string[] },
): Check[] {
  const all = [...accounts.payoutAccounts, ...(accounts.balanceAccounts ?? [])]
  if (!accounts.balanceAccounts || !all.every((a) => balance.has(a))) return []
  const total = all.reduce((s, a) => s + balance.get(a)!, 0)
  return [
    {
      label: `Salg − kjøp mot netto endring på Checkin ${all.join("+")}`,
      expected: plan.expectedPayout,
      actual: total,
      ok: Math.abs(plan.expectedPayout - total) <= TOLERANCE_ORE,
      source: "beregnet",
      hint: "Noen beløp i rapporten er ikke fanget opp av oppskriften, eller mva avviker fra Checkin.",
    },
  ]
}

/**
 * Uses the VAT Checkin actually charged instead of 25 % of the net, so the Checkin account in
 * Fiken matches Checkin to the øre instead of drifting by rounding every month. Only applied when
 * one line has that VAT type and the difference is rounding (≤ 1 kr); bigger differences are left
 * for the checks to flag.
 */
export function applyCheckinVat(
  plan: Plan,
  balance: Movements,
  vatAccounts: VatAccounts,
): { plan: Plan; adjusted: string[] } {
  const adjusted: string[] = []
  const adopt = (lines: Plan["sale"]["lines"], accounts: VatAccounts["outputVat"], sign: number) =>
    lines.map((line) => {
      const account = accounts[line.vatType]
      const reported = account === undefined ? undefined : balance.get(account)
      if (reported === undefined || lines.filter((l) => l.vatType === line.vatType).length !== 1)
        return line
      const vat = sign * reported
      if (vat === line.vat || Math.abs(vat - (line.vat ?? 0)) > TOLERANCE_ORE) return line
      adjusted.push(
        `"${line.description}": mva ${formatNok(line.vat ?? 0)} → ${formatNok(vat)} (fra Checkin ${account})`,
      )
      return { ...line, vat }
    })

  const saleLines = adopt(plan.sale.lines, vatAccounts.outputVat, -1)
  const purchaseLines = adopt(plan.purchase.lines, vatAccounts.inputVat, 1)
  const gross = (lines: Plan["sale"]["lines"]) =>
    lines.reduce((s, l) => s + l.netPrice + (l.vat ?? 0), 0)
  return {
    plan: {
      ...plan,
      sale: { lines: saleLines, gross: gross(saleLines) },
      purchase: { lines: purchaseLines, gross: gross(purchaseLines) },
      expectedPayout: gross(saleLines) - gross(purchaseLines),
    },
    adjusted,
  }
}
