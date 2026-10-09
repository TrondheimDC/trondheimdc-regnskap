// Cross-checks the computed Fiken lines against other numbers in the same Checkin report,
// so a misread PDF or a wrong account mapping shows up before anything is booked.

import type { Movements, Payout } from "./checkin.ts"
import type { VatType } from "./fiken.ts"
import { formatNok, netFromGross, type Plan } from "./plan.ts"

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

const VAT_LABELS: Record<string, string> = {
  HIGH: "25 % mva",
  MEDIUM: "15 % mva",
  LOW: "12 % mva",
  NONE: "uten mva",
  EXEMPT: "fritatt for mva",
  OUTSIDE: "utenfor mva",
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

/**
 * Our VAT per type against Checkin's VAT accounts. Within rounding (≤ 1 kr), and on the safe side
 * for Skatteetaten: output VAT not below what the tickets state, input VAT not above what Checkin
 * invoiced. Fiken derives VAT from the line amount, so we cannot always hit Checkin's figure.
 */
export function verifyPlan(plan: Plan, balance: Movements, vatAccounts: VatAccounts): Check[] {
  const checks: Check[] = []
  const add = (label: string, ours: number, checkin: number, side: "sale" | "purchase") => {
    const close = Math.abs(ours - checkin) <= TOLERANCE_ORE
    const safe = side === "sale" ? ours >= checkin : ours <= checkin
    checks.push({
      label,
      expected: ours,
      actual: checkin,
      ok: close && safe,
      hint: !close
        ? "Avviket er større enn øreavrunding. Sjekk mva-typen i oppskriften og at bilaget er lest riktig."
        : side === "sale"
          ? "Vi oppgir litt mindre utgående mva enn billettene viser. Det er øreavrunding, men i vår favør. Vurder om du vil føre likevel."
          : "Vi trekker fra litt mer inngående mva enn Checkin fakturerte. Det er øreavrunding, men i vår favør. Vurder om du vil føre likevel.",
    })
  }

  const saleVat = vatByType(plan.sale.lines)
  for (const [vatType, account] of Object.entries(vatAccounts.outputVat) as [VatType, string][]) {
    const reported = balance.get(account)
    if (reported === undefined) continue
    add(
      `Utgående ${VAT_LABELS[vatType]} mot Checkin ${account}`,
      saleVat.get(vatType) ?? 0,
      -reported,
      "sale",
    )
  }

  const purchaseVat = vatByType(plan.purchase.lines)
  for (const [vatType, account] of Object.entries(vatAccounts.inputVat) as [VatType, string][]) {
    const reported = balance.get(account)
    if (reported === undefined) continue
    add(
      `Inngående ${VAT_LABELS[vatType]} mot Checkin ${account}`,
      purchaseVat.get(vatType) ?? 0,
      reported,
      "purchase",
    )
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

/** Sum over the accounts, or undefined if none of them are in the report. */
const sumAccounts = (accounts: string[], from: Movements) =>
  accounts.some((a) => from.has(a))
    ? accounts.reduce((s, a) => s + (from.get(a) ?? 0), 0)
    : undefined

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
  const paidOut = sumAccounts(config.payoutAccounts, report.balance)
  if (paidOut !== undefined) {
    const movedOut = fiken.start - fiken.end + newTransfers
    checks.push({
      label: `Utbetalt til bank: Checkin ${config.payoutAccounts.join("+")} mot flyttet fra ${fiken.code} i Fiken`,
      expected: movedOut,
      actual: paidOut,
      ok: movedOut === paidOut,
      source: "Fiken",
      hint: "Noe annet er ført på Checkin-kontoen denne måneden, eller en utbetaling har feil beløp eller dato.",
    })
  }

  if (config.balanceAccounts) {
    const held = sumAccounts(config.balanceAccounts, report.closing)
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
      hint: "Oppskriften fanger ikke opp alle beløpene i bilaget, eller mva avviker fra Checkin.",
    },
  ]
}

/**
 * Books the gross Checkin actually charged (net + Checkin's VAT) instead of net + 25 %, so the
 * Checkin account in Fiken matches Checkin to the øre. Fiken only accepts net = gross / 1.25, so
 * the net is recomputed from the gross and the rounding moves between net and VAT. Only applied
 * when one line has that VAT type and the difference is rounding (≤ 1 kr); bigger differences
 * are left for the checks to flag.
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
      const checkinVat = sign * reported
      const vat = line.vat ?? 0
      if (checkinVat === vat || Math.abs(checkinVat - vat) > TOLERANCE_ORE) return line
      const gross = line.netPrice + checkinVat
      const netPrice = netFromGross(gross, line.vatType)
      if (netPrice === line.netPrice) return line
      adjusted.push(
        `"${line.description}": netto justert fra ${formatNok(line.netPrice)} til ${formatNok(netPrice)}, så summen blir ${formatNok(gross)} som hos Checkin. Mva blir ${formatNok(gross - netPrice)} (Checkin: ${formatNok(checkinVat)}).`,
      )
      return { ...line, netPrice, vat: gross - netPrice }
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

/** A line of a sale or purchase as booked in Fiken. */
export interface BookedLine {
  account: string
  vatType: string
  netPrice: number
  vat: number
}

function byAccountAndVat(
  lines: { account: string; vatType: string; netPrice: number; vat?: number }[],
) {
  const groups = new Map<string, { account: string; vatType: string; net: number; vat: number }>()
  for (const l of lines) {
    const key = `${l.account} ${l.vatType}`
    const g = groups.get(key) ?? { account: l.account, vatType: l.vatType, net: 0, vat: 0 }
    g.net += l.netPrice
    g.vat += l.vat ?? 0
    groups.set(key, g)
  }
  return groups
}

/**
 * For a month that is already booked: the sale and purchase lines in Fiken, summed per account
 * and VAT type, must match what the report gives. A missing, doubled or mis-keyed line shows up
 * as a difference. VAT may drift by rounding when Fiken computed it.
 */
export function verifyBooked(
  plan: Plan,
  booked: { sale: BookedLine[]; purchase: BookedLine[] },
): Check[] {
  const checks: Check[] = []
  for (const side of ["sale", "purchase"] as const) {
    const name = side === "sale" ? "Salg" : "Kjøp"
    const want = byAccountAndVat(plan[side].lines)
    const have = byAccountAndVat(booked[side])
    for (const key of new Set([...want.keys(), ...have.keys()])) {
      const w = want.get(key)
      const h = have.get(key)
      const { account, vatType } = (w ?? h)!
      const label = `${name} ${account}, ${VAT_LABELS[vatType] ?? vatType}`
      const hint = !h
        ? `Fant ikke linjen i Fiken. Sjekk at ${name.toLowerCase()}et er ført, med riktig konto og mva.`
        : !w
          ? "Linjen står ikke i bilaget. Sjekk konto og mva på føringen i Fiken."
          : `Beløpet er ulikt. Sjekk om ${name.toLowerCase()}et er ført to ganger eller med feil beløp.`
      checks.push({
        label: `${label}: netto i Fiken mot bilaget`,
        expected: h?.net ?? 0,
        actual: w?.net ?? 0,
        ok: (h?.net ?? 0) === (w?.net ?? 0),
        source: "Fiken",
        hint,
      })
      if (w?.vat || h?.vat) {
        checks.push({
          label: `${label}: mva i Fiken mot bilaget`,
          expected: h?.vat ?? 0,
          actual: w?.vat ?? 0,
          ok: Math.abs((h?.vat ?? 0) - (w?.vat ?? 0)) <= TOLERANCE_ORE,
          source: "Fiken",
          hint,
        })
      }
    }
  }
  return checks
}

/** For a booked month: every payout in the report must be moved to the bank in Fiken. */
export function verifyTransfersBooked(
  transfers: { voucher: string; date: string; amount: number; existing?: unknown }[],
): Check[] {
  return transfers.map((t) => ({
    label: `Utbetaling ${t.date} (Checkin-bilag ${t.voucher}) ført i Fiken`,
    expected: t.existing ? t.amount : 0,
    actual: t.amount,
    ok: t.existing !== undefined,
    source: "Fiken",
    hint: "Fant ingen postering på Checkin-kontoen med dette beløpet rundt denne datoen.",
  }))
}

/**
 * Reconciles the Checkin account for a month that is already booked. `booked` is the sale and
 * purchase found in Fiken; they are in the month's movement, so they are taken out to get what
 * was moved to the bank.
 */
export function reconcileBooked(
  booked: { sale: number; purchase: number },
  report: { closing: Movements; balance: Movements },
  fiken: FikenCheckinAccount,
  config: { payoutAccounts: string[]; balanceAccounts?: string[] },
): Check[] {
  const checks: Check[] = []
  const paidOut = sumAccounts(config.payoutAccounts, report.balance)
  if (paidOut !== undefined) {
    const movedOut = fiken.start - fiken.end + booked.sale - booked.purchase
    checks.push({
      label: `Utbetalt til bank: Checkin ${config.payoutAccounts.join("+")} mot flyttet fra ${fiken.code} i Fiken`,
      expected: movedOut,
      actual: paidOut,
      ok: movedOut === paidOut,
      source: "Fiken",
      hint: "En utbetaling mangler, er ført to ganger, har feil beløp eller er datert i en annen måned.",
    })
  }
  if (config.balanceAccounts) {
    const held = sumAccounts(config.balanceAccounts, report.closing)
    if (held !== undefined) {
      checks.push({
        label: `Saldo: ${fiken.code} i Fiken mot Checkin ${config.balanceAccounts.join("+")}`,
        expected: fiken.end,
        actual: held,
        ok: Math.abs(fiken.end - held) <= TOLERANCE_ORE,
        source: "Fiken",
        hint: "Saldoen i Fiken stemmer ikke med det Checkin har til gode for oss. Avviket kan stamme fra en tidligere måned.",
      })
    }
  }
  return checks
}
