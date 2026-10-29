// Cross-checks the computed Fiken lines against other numbers in the same Checkin report (or hotel
// invoice), so a misread PDF or a wrong account mapping shows up before anything is booked.

import { CHECKIN_ACCOUNTS, type Movements, type Payout } from "./checkin.ts"
import type { VatRate } from "./config.ts"
import type { VatType } from "./fiken.ts"
import type { HotelInvoice, HotelPlan, Split } from "./hotel.ts"
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
  /** Name for `actual` when printed. Default "Checkin". */
  reference?: string
  /** Hint shown when the check fails. */
  hint?: string
  /** A passing check with something worth a look, e.g. an unusual mva type. Shown, but never blocks. */
  note?: string
  /** Shown even when it passes: the Checkin account in Fiken against what Checkin holds for us. */
  pinned?: boolean
  /** Shown instead of the two amounts, for a check that doesn't compare sums. */
  detail?: string
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
 * Reconciles our Checkin account in Fiken (e.g. 1960:10001) against the report, as it will be
 * once the whole month is in Fiken (`newTransfers`: payouts not yet moved to the bank in Fiken;
 * `booked`: gross of a sale or purchase for the month already booked, which is not booked again):
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
  booked: { sale?: number; purchase?: number } = {},
): Check[] {
  const checks: Check[] = []
  const paidOut = sumAccounts(config.payoutAccounts, report.balance)
  if (paidOut !== undefined) {
    // A sale or purchase already booked is in `end` too; only payouts count as moved out.
    const movedOut =
      fiken.start - fiken.end + (booked.sale ?? 0) - (booked.purchase ?? 0) + newTransfers
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
      const after =
        fiken.end +
        (booked.sale === undefined ? plan.sale.gross : 0) -
        (booked.purchase === undefined ? plan.purchase.gross : 0) -
        newTransfers
      checks.push({
        label: `Saldo etter føring: ${fiken.code} i Fiken mot Checkin ${config.balanceAccounts.join("+")}`,
        expected: after,
        actual: held,
        ok: Math.abs(after - held) <= TOLERANCE_ORE,
        source: "Fiken etter føring",
        hint: "Saldoen i Fiken blir ikke lik det Checkin har til gode for oss. Avviket kan stamme fra en tidligere måned.",
        pinned: true,
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
 * A balance account in the report that the config doesn't name (payout, balance, VAT or ignore),
 * e.g. 2900 Gjeld til kunde or 1922 Direktebetaling. It may need its own booking, so it gets a note.
 * New result accounts don't get here: `toReport` stops on them.
 */
export function verifyKnownAccounts(
  balance: Movements,
  config: {
    ignore: string[]
    reconcile: VatAccounts & { payoutAccounts: string[]; balanceAccounts?: string[] }
  },
): Check[] {
  const { payoutAccounts, balanceAccounts = [], outputVat, inputVat } = config.reconcile
  const known = new Set([
    ...config.ignore,
    ...payoutAccounts,
    ...balanceAccounts,
    ...Object.values(outputVat),
    ...Object.values(inputVat),
  ])
  return [...balance]
    .filter(([account, net]) => net !== 0 && !known.has(account))
    .map(([account, net]) => {
      const meaning = CHECKIN_ACCOUNTS[account]
      return {
        label: `Ny konto i bilaget: ${account}${meaning ? ` ${meaning.split(":")[0]}` : ""}`,
        expected: 0,
        actual: net,
        ok: true,
        detail: `Netto endring ${formatNok(net)}`,
        note: `${meaning ? `${meaning}. ` : ""}Oppskriften kjenner ikke kontoen, så den føres ikke. Avklar med regnskapsfører før du fører.`,
      }
    })
}

/**
 * The report is read as one event: every sale becomes one line, e.g. "TDC 2026". A report that
 * names two years of the event (sales for next year started early) would mix them in one booking.
 * Other events, e.g. the partner stand, are fine as long as they don't name another year.
 */
export function verifyEvent(text: string[] | undefined, event: string | undefined): Check[] {
  if (!text || !event) return []
  const name = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(?<![\\p{L}\\d])${name}\\s*(\\d{4})(?!\\d)`, "giu")
  const years = [...new Set(text.flatMap((t) => [...t.matchAll(pattern)].map((m) => m[1]!)))].sort()
  const found = years.map((y) => `${event} ${y}`)
  const label = `Bare ett ${event}-arrangement i bilaget`
  if (years.length === 0) {
    return [
      {
        label,
        expected: 0,
        actual: 0,
        ok: true,
        detail: `Fant ikke «${event} ÅÅÅÅ»`,
        note: "Bilaget nevner ikke arrangementet, så det er ikke kontrollert at bare ett år er med.",
      },
    ]
  }
  return [
    {
      label,
      expected: 1,
      actual: years.length,
      ok: years.length === 1,
      detail: found.join(", "),
      hint: `Bilaget har salg for flere år. Verktøyet fører alt som ett salg og kan ikke skille ${found.join(" og ")} ennå.`,
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
 * A line booked with a net and VAT a few øre off Checkin's, with the same gross.
 *
 * Checkin rounds VAT on every ticket and fee and sums it, so its VAT is not exactly 25 % of its
 * net. Fiken computes VAT from the line and rejects any other amount (net must be gross / 1,25).
 * We keep Checkin's gross so the Checkin account matches to the øre, and let net and VAT move.
 */
export interface Rounding {
  side: "sale" | "purchase"
  description: string
  checkin: { net: number; vat: number }
  booked: { net: number; vat: number }
}

/** Short note for the review screen and CLI. */
export function explainRounding(r: Rounding): string {
  return `${r.description}: mva ${formatNok(r.booked.vat)}, Checkin ${formatNok(r.checkin.vat)}. Sum inkl. mva er lik.`
}

/** Line text in Fiken, so the voucher itself explains the difference from the attachment. */
export function roundingLineText(r: Rounding): string {
  return `${r.description} (øreavrunding, mva hos Checkin ${formatNok(r.checkin.vat)})`
}

/**
 * Books the gross Checkin actually charged (net + Checkin's VAT) instead of net + 25 %, so the
 * Checkin account in Fiken matches Checkin to the øre. See `Rounding`. Only applied when one line
 * has that VAT type and the difference is rounding (≤ 1 kr); bigger differences are left for the
 * checks to flag.
 */
export function applyCheckinVat(
  plan: Plan,
  balance: Movements,
  vatAccounts: VatAccounts,
): { plan: Plan; adjusted: Rounding[] } {
  const adjusted: Rounding[] = []
  const adopt = (
    side: Rounding["side"],
    lines: Plan["sale"]["lines"],
    accounts: VatAccounts["outputVat"],
    sign: number,
  ) =>
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
      adjusted.push({
        side,
        description: line.description,
        checkin: { net: line.netPrice, vat: checkinVat },
        booked: { net: netPrice, vat: gross - netPrice },
      })
      return { ...line, netPrice, vat: gross - netPrice }
    })

  const saleLines = adopt("sale", plan.sale.lines, vatAccounts.outputVat, -1)
  const purchaseLines = adopt("purchase", plan.purchase.lines, vatAccounts.inputVat, 1)
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

/** The rates we book with. Any other type with no VAT on the line counts as "NONE". */
const RATED = new Set(["HIGH", "MEDIUM", "LOW"])

/** E.g. HIGH_BASIS puts no VAT on the line, same as NONE; only the mva-melding differs. */
export const effectiveVatType = (l: { vatType: string; vat?: number }) =>
  RATED.has(l.vatType) || l.vat ? l.vatType : "NONE"

function byAccountAndVat(
  lines: { account: string; vatType: string; netPrice: number; vat?: number }[],
) {
  const groups = new Map<
    string,
    { account: string; vatType: string; types: Set<string>; net: number; vat: number }
  >()
  for (const l of lines) {
    const vatType = effectiveVatType(l)
    const key = `${l.account} ${vatType}`
    const g = groups.get(key) ?? { account: l.account, vatType, types: new Set(), net: 0, vat: 0 }
    g.types.add(l.vatType)
    g.net += l.netPrice
    g.vat += l.vat ?? 0
    groups.set(key, g)
  }
  return groups
}

/**
 * For a month that is already booked: the sale and purchase lines in Fiken, summed per account
 * and VAT type, must match what the report gives. The month may be split over several vouchers
 * and lines (e.g. one line per event); only the sums count. A missing, doubled or mis-keyed line
 * shows up as a difference. Net and VAT may drift by rounding, since Fiken rounds every line.
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
      // The sums match, but Fiken has another type than we would book, e.g. HIGH_BASIS for NONE.
      const other = [...(h?.types ?? [])].filter((t) => t !== vatType)
      const note =
        other.length > 0
          ? `Ført med mva-type ${other.join(", ")} i Fiken, ikke «${VAT_LABELS[vatType] ?? vatType}». Beløpet stemmer og det er ikke trukket mva. Bytt mva-type i Fiken om du vil rydde.`
          : undefined
      const hint = !h
        ? `Fant ikke linjen i Fiken. Sjekk at ${name.toLowerCase()}et er ført, med riktig konto og mva.`
        : !w
          ? "Linjen står ikke i bilaget. Sjekk konto og mva på føringen i Fiken."
          : `Summen er ulik. Sjekk om ${name.toLowerCase()}et er ført to ganger eller med feil beløp.`
      const net = { fiken: h?.net ?? 0, report: w?.net ?? 0 }
      const vat = { fiken: h?.vat ?? 0, report: w?.vat ?? 0 }
      checks.push({
        label: `${label}: netto i Fiken mot bilaget`,
        expected: net.fiken,
        actual: net.report,
        ok: Math.abs(net.fiken - net.report) <= TOLERANCE_ORE,
        source: "Fiken",
        hint,
        note,
      })
      if (vat.fiken || vat.report) {
        checks.push({
          label: `${label}: mva i Fiken mot bilaget`,
          expected: vat.fiken,
          actual: vat.report,
          ok: Math.abs(vat.fiken - vat.report) <= TOLERANCE_ORE,
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
 * purchase found in Fiken, and `rounded` what øreavrunding entries moved on the account; they are
 * in the month's movement, so they are taken out to get what was moved to the bank.
 */
export function reconcileBooked(
  booked: { sale: number; purchase: number; rounded?: number },
  report: { closing: Movements; balance: Movements },
  fiken: FikenCheckinAccount,
  config: { payoutAccounts: string[]; balanceAccounts?: string[] },
): Check[] {
  const checks: Check[] = []
  const paidOut = sumAccounts(config.payoutAccounts, report.balance)
  if (paidOut !== undefined) {
    const movedOut = fiken.start - fiken.end + booked.sale - booked.purchase + (booked.rounded ?? 0)
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
        pinned: true,
      })
    }
  }
  return checks
}

/**
 * A month booked before we booked Checkin's gross (see `Rounding`): Checkin's net with VAT
 * computed by Fiken. The gross, and so the Checkin account, is then a few øre off Checkin's.
 * Counted per month, so correcting one month never changes what another month is off by.
 */
export interface RoundingDrift {
  /** Sale minus purchase, incl. VAT, as booked in Fiken. */
  booked: number
  /** The same according to the report: Checkin's gross. */
  checkin: number
  /** What øreavrunding entries dated in the month already moved on the Checkin account. */
  rounded: number
  /** What the Checkin account is off by from this month: positive means too much in Fiken. */
  off: number
}

export function roundingDrift(
  plan: Plan,
  booked: { sale: number; purchase: number },
  rounded: number,
): RoundingDrift {
  const sum = booked.sale - booked.purchase
  return {
    booked: sum,
    checkin: plan.expectedPayout,
    rounded,
    off: sum + rounded - plan.expectedPayout,
  }
}

const ROUNDING_LABEL = "Salg − kjøp inkl. mva"

/** The check from `verifyRounding`. Booking the øreavrunding is what fixes it, so it doesn't block that. */
export const isRoundingCheck = (c: Check) => c.label.startsWith(ROUNDING_LABEL)

/**
 * Sale minus purchase incl. VAT in Fiken (with øreavrunding entries) against the report. Only for
 * a difference within rounding; a bigger one is a wrong or missing line, which `verifyBooked` flags.
 */
export function verifyRounding(drift: RoundingDrift, checkinAccount: string): Check[] {
  if (Math.abs(drift.off) > TOLERANCE_ORE) return []
  return [
    {
      label: `${ROUNDING_LABEL}${drift.rounded ? " og øreavrunding" : ""} i Fiken mot bilaget`,
      expected: drift.booked + drift.rounded,
      actual: drift.checkin,
      ok: drift.off === 0,
      source: "Fiken",
      hint: `Måneden er ført med netto fra Checkin og mva regnet av Fiken, så ${checkinAccount} er ${formatNok(Math.abs(drift.off))} for ${drift.off > 0 ? "høy" : "lav"}. Før øreavrunding for å rette det.`,
    },
  ]
}

/** A fri postering between the Checkin account and the rounding account that evens out `RoundingDrift`. */
export interface RoundingCorrection {
  month: string
  /** Last day of the month, so the month's own balance is right. */
  date: string
  /** Change to the Checkin account: negative takes money out of it. Never 0. */
  amount: number
  debitAccount: string
  creditAccount: string
  description: string
  /** `RoundingDrift.rounded` it was computed from; booking refuses if Fiken has changed since. */
  rounded: number
}

/** The correction for a drift within rounding (≤ 1 kr), or undefined if there is nothing to correct. */
export function roundingCorrection(
  plan: Plan,
  drift: RoundingDrift,
  accounts: { checkinAccount: string; roundingAccount: string },
): RoundingCorrection | undefined {
  if (drift.off === 0 || Math.abs(drift.off) > TOLERANCE_ORE) return undefined
  const amount = -drift.off
  const { checkinAccount, roundingAccount } = accounts
  return {
    month: plan.month,
    date: plan.date,
    amount,
    debitAccount: amount > 0 ? checkinAccount : roundingAccount,
    creditAccount: amount > 0 ? roundingAccount : checkinAccount,
    description: `Øreavrunding Checkin ${plan.month}: ført med mva regnet av Fiken, Checkin regner mva per billett. Sum inkl. mva i bilaget ${formatNok(drift.checkin)}, i Fiken ${formatNok(drift.booked + drift.rounded)}`,
    rounded: drift.rounded,
  }
}

// ---------------------------------------------------------------------------------------------
// The hotel's conference invoice

/** Room lines are split per line; each line can round a few øre off the hotel's own split. */
const SPLIT_TOLERANCE_PER_LINE = 10

const rateText = (rate: number) => `${rate} %`
const lineList = (lines: { n: number }[]) =>
  lines
    .slice(0, 8)
    .map((l) => `#${l.n}`)
    .join(", ") + (lines.length > 8 ? ` og ${lines.length - 8} til` : "")

/**
 * The invoice against itself: every line, the lines per section and rate against page 1, page 1
 * against the VAT specification, and both against the invoice total.
 */
export function verifyHotelInvoice(invoice: HotelInvoice, split: Split): Check[] {
  const checks: Check[] = []
  const sumOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

  const wrong = invoice.lines.filter((l) => l.net + l.vat !== l.gross)
  checks.push({
    label: "Netto + mva = total på hver linje",
    expected: sumOf(invoice.lines.map((l) => l.net + l.vat)),
    actual: sumOf(invoice.lines.map((l) => l.gross)),
    ok: wrong.length === 0,
    detail:
      wrong.length === 0 ? `${invoice.lines.length} linjer` : `Stemmer ikke på ${lineList(wrong)}`,
    hint: "Linjen er trolig lest feil fra PDF-en. Sammenlign med fakturaen.",
  })

  // Lines per section and rate (rooms split between their two rates) against page 1.
  const keys = new Map<string, { section: string; rate: VatRate }>()
  for (const s of invoice.sections) keys.set(`${s.section}:${s.rate}`, s)
  for (const l of invoice.lines)
    for (const p of split.parts.get(l.n) ?? [])
      keys.set(`${l.section}:${p.rate}`, { section: l.section, rate: p.rate })
  for (const { section, rate } of keys.values()) {
    const lines = sumOf(
      invoice.lines
        .filter((l) => l.section === section)
        .flatMap((l) => split.parts.get(l.n) ?? [])
        .filter((p) => p.rate === rate)
        .map((p) => p.gross),
    )
    const printed = invoice.sections.find((s) => s.section === section && s.rate === rate)
    checks.push({
      label: `${section || "Uten seksjon"} ${rateText(rate)}: linjene mot side 1`,
      expected: lines,
      actual: printed?.gross ?? 0,
      ok: lines === (printed?.gross ?? 0),
      source: "linjene",
      reference: "side 1",
      hint: printed
        ? "Summen av linjene stemmer ikke med side 1. Sjekk at alle linjer er lest."
        : "Side 1 har ingen sum for denne seksjonen og satsen.",
    })
  }

  for (const s of split.sections) {
    const mixed = invoice.lines.filter((l) => l.section === s.section && l.rate === "mixed")
    const high = Math.max(...(Object.keys(s.printed).map(Number) as VatRate[]))
    const computed = s.computed[high as VatRate] ?? 0
    const printed = s.printed[high as VatRate] ?? 0
    checks.push({
      label: `${s.section}: linjene delt på ${Object.keys(s.printed)
        .map((r) => rateText(Number(r)))
        .join(" og ")} mot side 1`,
      expected: computed,
      actual: printed,
      ok: Math.abs(computed - printed) <= SPLIT_TOLERANCE_PER_LINE * mixed.length,
      source: `${rateText(high)} per linje`,
      reference: "side 1",
      hint: "Delingen per linje er langt fra side 1. Sjekk at rom- og frokostlinjene er lest riktig.",
    })
  }
  if (split.unsplit.length > 0) {
    checks.push({
      label: "Linjer med blandet mva",
      expected: sumOf(split.unsplit.map((l) => l.gross)),
      actual: 0,
      ok: false,
      detail: `Kan ikke deles på satser: ${lineList(split.unsplit)}`,
      hint: "Seksjonen har ikke to satser på side 1, så linjene kan ikke deles. Før fakturaen for hånd.",
    })
  }

  const rates = new Set<VatRate>([
    ...invoice.sections.map((s) => s.rate),
    ...invoice.vatSpec.map((v) => v.rate),
  ])
  for (const rate of rates) {
    const sections = sumOf(invoice.sections.filter((s) => s.rate === rate).map((s) => s.gross))
    const spec = invoice.vatSpec.find((v) => v.rate === rate)
    const specGross = spec ? spec.base + spec.vat : 0
    checks.push({
      label: `${rateText(rate)}: side 1 mot mva-spesifikasjonen`,
      expected: sections,
      actual: specGross,
      ok: sections === specGross,
      source: "seksjonene",
      reference: "grunnlag + mva",
    })
  }
  for (const spec of invoice.vatSpec) {
    const vat = Math.round((spec.base * spec.rate) / 100)
    checks.push({
      label: `Mva-spesifikasjonen ${rateText(spec.rate)}: grunnlag × sats`,
      expected: vat,
      actual: spec.vat,
      ok: Math.abs(vat - spec.vat) <= TOLERANCE_ORE,
      reference: "fakturaen",
    })
  }

  checks.push({
    label: "Mva-spesifikasjonen mot fakturatotal",
    expected: sumOf(invoice.vatSpec.map((v) => v.base + v.vat)),
    actual: invoice.total,
    ok: sumOf(invoice.vatSpec.map((v) => v.base + v.vat)) === invoice.total,
    source: "grunnlag + mva",
    reference: "fakturatotal",
  })
  checks.push({
    label: "Alle linjene mot fakturatotal",
    expected: sumOf(invoice.lines.map((l) => l.gross)),
    actual: invoice.total,
    ok: sumOf(invoice.lines.map((l) => l.gross)) === invoice.total,
    source: "linjene",
    reference: "fakturatotal",
    hint: "Noen linjer mangler eller er lest dobbelt.",
  })
  return checks
}

/**
 * The purchase against the invoice: every line has a category, the purchase adds up to the invoice
 * total, the VAT per rate matches the VAT specification, and the supplier is the hotel.
 */
export function verifyHotelPlan(
  plan: HotelPlan,
  invoice: HotelInvoice,
  supplierOrgNr: string,
): Check[] {
  const checks: Check[] = []
  const unplaced = plan.unplaced.reduce((s, l) => s + l.gross, 0)
  checks.push({
    label: "Alle linjene har kategori",
    expected: unplaced,
    actual: 0,
    ok: plan.unplaced.length === 0 && plan.unknown.length === 0,
    detail:
      plan.unknown.length > 0
        ? `Ukjent kategori: ${plan.unknown.join(", ")}`
        : plan.unplaced.length === 0
          ? `${plan.placements.length} linjer`
          : `${plan.unplaced.length} linjer uten kategori (${lineList(plan.unplaced)}), ${formatNok(unplaced)}`,
    hint: "Flytt linjene til en kategori, eller legg til en regel i oppskriften.",
  })
  checks.push({
    label: "Kjøpet mot fakturatotal",
    expected: plan.gross,
    actual: invoice.total,
    ok: plan.gross === invoice.total,
    source: "kjøpet",
    reference: "fakturaen",
  })
  for (const spec of invoice.vatSpec) {
    const lines = plan.lines.filter((l) => l.rate === spec.rate)
    const vat = lines.reduce((s, l) => s + l.invoiceVat, 0)
    const deducted = lines.reduce((s, l) => s + (l.vat ?? 0), 0)
    checks.push({
      label: `Mva ${rateText(spec.rate)}: kjøpet mot mva-spesifikasjonen`,
      expected: vat,
      actual: spec.vat,
      // Fiken derives VAT per line from the gross, so allow rounding, but never deduct more.
      ok: Math.abs(vat - spec.vat) <= TOLERANCE_ORE && deducted <= spec.vat,
      source: "kjøpet",
      reference: "fakturaen",
      hint:
        deducted > spec.vat
          ? "Vi trekker fra mer inngående mva enn fakturaen viser."
          : "Avviket er større enn øreavrunding. Sjekk at linjene er lest riktig.",
    })
  }
  checks.push({
    label: "Leverandøren på fakturaen",
    expected: 0,
    actual: 0,
    ok: invoice.supplierOrgNr === supplierOrgNr,
    detail: `${invoice.supplierName ?? "Ukjent"}, org.nr. ${invoice.supplierOrgNr ?? "ikke funnet"}${
      invoice.supplierOrgNr === supplierOrgNr ? "" : ` (oppskriften: ${supplierOrgNr})`
    }`,
    hint: "Fakturaen er ikke fra hotellet i oppskriften.",
  })
  return checks
}

/** What Fiken read from the EHF against what we read from its PDF. */
export function verifyEhf(
  invoice: HotelInvoice,
  ehf: { invoiceNumber?: string | null; gross?: number | null; kid?: string | null },
): Check[] {
  const checks: Check[] = [
    {
      label: "Fakturanummer i EHF-en",
      expected: 0,
      actual: 0,
      ok: ehf.invoiceNumber === invoice.number,
      detail: `PDF ${invoice.number}, EHF ${ehf.invoiceNumber ?? "mangler"}`,
      hint: "EHF-en og PDF-en er ikke samme faktura.",
    },
  ]
  if (ehf.gross != null)
    checks.push({
      label: "Fakturatotal i EHF-en",
      expected: invoice.total,
      actual: ehf.gross,
      ok: invoice.total === ehf.gross,
      source: "PDF",
      reference: "EHF",
    })
  if (ehf.kid && invoice.kid && ehf.kid !== invoice.kid)
    checks.push({
      label: "KID i EHF-en",
      expected: 0,
      actual: 0,
      ok: false,
      detail: `PDF ${invoice.kid}, EHF ${ehf.kid}`,
      hint: "KID-en på kjøpet hentes fra PDF-en. Sjekk hvilken som er riktig.",
    })
  return checks
}
