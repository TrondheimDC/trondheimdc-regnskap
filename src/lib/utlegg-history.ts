// How utlegg have been booked in Fiken before, by hand or by us: which accounts and VAT types,
// which currency, and how they were paid. Read-only; it answers "how did the regnskapsfører do
// it?" before the recipe is trusted.
//
// An utlegg is found as either
//   - a purchase from a person (a supplier without organisation number), or one whose identifier or
//     a line says utlegg / expense / refusjon (booked with the shop as supplier, or as cash), or
//   - a journal entry made with Fiken's own utlegg flow (transaction type "Kontantutlegg").

import type { JournalEntry, PurchaseResult } from "./fiken.ts"

export interface PastUtleggLine {
  account: string
  /** Fiken's VAT type on a purchase line, or the VAT code on a journal entry line. */
  vat: string
  /** In NOK øre; Fiken converts lines in another currency. */
  net: number
  vatAmount: number
  description?: string
}

export interface PastUtlegg {
  source: "purchase" | "kontantutlegg"
  id: number
  date: string
  /** The person, for a purchase. */
  who?: string
  description?: string
  kind?: string
  currency?: string
  paid?: boolean
  /** Accounts the payment went through, e.g. 1920:10001 or 2910. */
  paidFrom: string[]
  lines: PastUtleggLine[]
}

const UTLEGG_TEXT = /utlegg|expense|refusjon|reimburs/i

/** Purchases from people and Kontantutlegg journal entries, oldest first. */
export function pastUtlegg(purchases: PurchaseResult[], entries: JournalEntry[]): PastUtlegg[] {
  const fromPurchases = purchases
    .filter(
      (p) =>
        !p.deleted &&
        ((p.supplier && !p.supplier.organizationNumber) ||
          // Also an utlegg booked with the shop as supplier or as a cash purchase, named in a line.
          [p.identifier, ...p.lines.map((l) => l.description)].some((t) =>
            UTLEGG_TEXT.test(t ?? ""),
          )),
    )
    .map(
      (p): PastUtlegg => ({
        source: "purchase",
        id: p.purchaseId,
        date: p.date ?? "",
        who: p.supplier?.name ?? undefined,
        description: p.identifier ?? undefined,
        kind: p.kind ?? undefined,
        currency: p.currency ?? undefined,
        paid: p.paid ?? undefined,
        paidFrom: [...new Set((p.payments ?? []).map((x) => x.account).filter(isString))],
        lines: p.lines.map((l) => ({
          account: l.account ?? "?",
          vat: l.vatType ?? "?",
          net: l.netPrice ?? 0,
          vatAmount: l.vat ?? 0,
          description: l.description ?? undefined,
        })),
      }),
    )
  const fromEntries = entries
    .filter((e) => e.transactionType === "Kontantutlegg" && !e.offsetTransactionId)
    .map(
      (e): PastUtlegg => ({
        source: "kontantutlegg",
        id: e.journalEntryId,
        date: e.date ?? "",
        description: e.description ?? undefined,
        // Expense lines are debits (positive); the credit is the debt or the payment.
        paidFrom: e.lines.filter((l) => l.amount < 0 && l.account).map((l) => l.account!),
        lines: e.lines
          .filter((l) => l.amount > 0)
          .map((l) => ({
            account: l.account ?? "?",
            vat: l.vatCode ?? "–",
            net: l.amount,
            vatAmount: 0,
          })),
      }),
    )
  return [...fromPurchases, ...fromEntries].sort((a, b) => a.date.localeCompare(b.date))
}

const isString = (s: string | null | undefined): s is string => typeof s === "string"

export interface UtleggPractice {
  account: string
  vat: string
  count: number
  net: number
  vatAmount: number
}

/** Expense lines grouped by account and VAT: what is usual, most used first. */
export function utleggPractice(items: PastUtlegg[]): UtleggPractice[] {
  const groups = new Map<string, UtleggPractice>()
  for (const line of items.flatMap((i) => i.lines)) {
    // Balance lines (VAT, debt, bank) are not where the cost was booked.
    if (!/^[4-8]\d{3}/.test(line.account)) continue
    const key = `${line.account}|${line.vat}`
    const g = groups.get(key) ?? {
      account: line.account,
      vat: line.vat,
      count: 0,
      net: 0,
      vatAmount: 0,
    }
    g.count++
    g.net += line.net
    g.vatAmount += line.vatAmount
    groups.set(key, g)
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.account.localeCompare(b.account),
  )
}
