// The chart of accounts grouped by account class (NS 4102), for picking an expense account.

import type { Account } from "./fiken.ts"

/** Account classes in the Norwegian standard chart of accounts (NS 4102). */
export const ACCOUNT_CLASSES: Record<string, string> = {
  "1": "Eiendeler",
  "2": "Egenkapital og gjeld",
  "3": "Salgsinntekt",
  "4": "Varekostnad",
  "5": "Lønnskostnad",
  "6": "Annen driftskostnad: lokaler, leie, kontor",
  "7": "Annen driftskostnad: reise, salg, representasjon",
  "8": "Finans",
}

export interface AccountGroup {
  /** First digit, e.g. "6". */
  klass: string
  label: string
  accounts: Account[]
}

/** Accounts grouped by class, in account order. */
export function groupAccounts(accounts: Account[]): AccountGroup[] {
  const groups = new Map<string, Account[]>()
  for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code))) {
    const klass = a.code.charAt(0)
    groups.set(klass, [...(groups.get(klass) ?? []), a])
  }
  return [...groups].map(([klass, list]) => ({
    klass,
    label: `${klass}xxx · ${ACCOUNT_CLASSES[klass] ?? "Andre kontoer"}`,
    accounts: list,
  }))
}
