// Fiken's API cannot read or link bank lines; it only says how far a bank account is reconciled.
// From that we point the user at the bankavstemming page for the payouts still to link.

const FIKEN_WEB_URL = "https://fiken.no"

/** Days around a payout to show: the bank line's date can differ from Checkin's by a day or two. */
const MARGIN_DAYS = 3

export interface BankReconciliation {
  accountCode: string
  bankAccountId: number
  /** Last day the bank account is reconciled through in Fiken; none if never. */
  reconciledDate?: string
  /**
   * Payouts booked in Fiken but after `reconciledDate`: their bank lines may not be linked yet.
   * Each with the bankavstemming narrowed to its day.
   */
  pending: { date: string; amount: number; url: string }[]
  /** Fiken's bankavstemming, narrowed to the pending payouts' days. */
  url: string
}

/** Payouts dated after the last reconciled day (all of them if the account was never reconciled). */
export function unreconciled<T extends { date: string }>(payouts: T[], reconciledDate?: string) {
  return payouts.filter((p) => !reconciledDate || p.date > reconciledDate)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The bankavstemming page in Fiken for one bank account, optionally limited to these dates. */
export function bankReconciliationUrl(
  companySlug: string,
  bankAccountId: number,
  dates: string[] = [],
): string {
  const url = new URL(
    `/foretak/${encodeURIComponent(companySlug)}/bank/bkbf/${bankAccountId}`,
    FIKEN_WEB_URL,
  )
  const sorted = [...dates].sort()
  const [first, last] = [sorted[0], sorted.at(-1)]
  if (first && last) {
    url.searchParams.set("fra", addDays(first, -MARGIN_DAYS))
    url.searchParams.set("til", addDays(last, MARGIN_DAYS))
  }
  return url.toString()
}
