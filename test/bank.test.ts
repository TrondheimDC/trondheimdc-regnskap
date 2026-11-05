import { expect, test } from "vitest"
import { bankReconciliationUrl, unreconciled } from "../src/lib/bank.ts"

test("payouts after the reconciled date are left to link", () => {
  const payouts = [{ date: "2026-09-07" }, { date: "2026-09-08" }, { date: "2026-09-21" }]
  expect(unreconciled(payouts, undefined)).toEqual(payouts)
  expect(unreconciled(payouts, "2026-09-07")).toEqual([
    { date: "2026-09-08" },
    { date: "2026-09-21" },
  ])
  expect(unreconciled(payouts, "2026-09-30")).toEqual([])
})

test("the link narrows bankavstemmingen to a few days around the payouts", () => {
  expect(bankReconciliationUrl("trondheimdc", 42, ["2026-09-21", "2026-08-30"])).toBe(
    "https://fiken.no/foretak/trondheimdc/bank/bkbf/42?fra=2026-08-27&til=2026-09-24",
  )
  expect(bankReconciliationUrl("trondheimdc", 42)).toBe(
    "https://fiken.no/foretak/trondheimdc/bank/bkbf/42",
  )
})
