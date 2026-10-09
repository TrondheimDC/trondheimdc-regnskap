import { readFile } from "node:fs/promises"
import { expect, test } from "vitest"
import { parseAmount, parseAmountsArg, parseReportPdf, toReport } from "../src/lib/checkin.ts"
import { Config } from "../src/lib/config.ts"
import { buildPlan, lastDayOfMonth } from "../src/lib/plan.ts"
import {
  applyCheckinVat,
  reconcile,
  verifyNet,
  verifyPayoutList,
  verifyPlan,
} from "../src/lib/verify.ts"
import { checkinPdf, MARCH_2026 } from "./pdf-fixture.ts"

const config = Config.parse(
  JSON.parse(await readFile(new URL("../regnskap.config.json", import.meta.url), "utf8")),
)

async function marchPlan() {
  const report = await parseReportPdf(MARCH_2026)
  const computed = buildPlan(toReport("2026-03", report.movements, config), config)
  return { report, computed, ...applyCheckinVat(computed, report.balance, config.reconcile) }
}

test("parseAmount handles Norwegian and plain formats", () => {
  expect(parseAmount("-427 521,63")).toBe(-42752163)
  expect(parseAmount("1.234,56")).toBe(123456)
  expect(parseAmount("1234.5")).toBe(123450)
  expect(parseAmount("1,234,567")).toBe(123456700)
  expect(parseAmount("−100")).toBe(-10000)
  expect(parseAmount("-")).toBeUndefined()
  expect(parseAmount("3000 - Sales")).toBeUndefined()
})

test("lastDayOfMonth", () => {
  expect(lastDayOfMonth("2026-03")).toBe("2026-03-31")
  expect(lastDayOfMonth("2028-02")).toBe("2028-02-29")
})

test("reads the summary page, not the cover or detail pages", async () => {
  const { month, movements, balance, closing, payouts } = await parseReportPdf(MARCH_2026)
  expect(month).toBe("2026-03")
  expect(Object.fromEntries(movements)).toEqual({
    "3000": 4938000,
    "3990": -4938000,
    "4300": 123440,
    "4335": 151238,
  })
  expect(balance.get("1920")).toBe(5000000)
  expect(balance.get("2701")).toBe(-1234500)
  expect(closing.get("1921")).toBe(4566957)
  expect(closing.has("2701")).toBe(true)
  expect(payouts).toEqual([
    { voucher: "17342:13", date: "2026-03-08", amount: 2000000 },
    { voucher: "17342:14", date: "2026-03-22", amount: 3000000 },
  ])
})

test("follows the recipe with the gross Checkin charged", async () => {
  const { computed, plan, adjusted } = await marchPlan()
  expect(computed.purchase.lines[0]!.vat).toBe(30860) // 25 % of 1 234,40
  expect(adjusted).toHaveLength(1)
  expect(plan.date).toBe("2026-03-31")
  expect(plan.sale.lines).toEqual([
    { description: "TDC 2026", netPrice: 4938000, vat: 1234500, vatType: "HIGH", account: "3000" },
  ])
  expect(plan.purchase.lines).toEqual([
    {
      description: "Checkin gebyr",
      // Checkin: 1 234,40 + 308,65 mva. Fiken requires net = gross / 1,25.
      netPrice: 123444,
      vat: 30861,
      vatType: "HIGH",
      account: "4300",
    },
    {
      description: "Transaksjonsgebyr",
      netPrice: 151238,
      vat: 0,
      vatType: "NONE",
      account: "4300",
    },
  ])
  // Exactly what Checkin moved: 50 000 paid out + 5 000 receivable + 3 669,57 held.
  expect(plan.expectedPayout).toBe(5866957)
})

test("all report checks pass on a consistent report", async () => {
  const { report, plan } = await marchPlan()
  const checks = [
    ...verifyPlan(plan, report.balance, config.reconcile),
    ...verifyPayoutList(report, config.reconcile.payoutAccounts),
    ...verifyNet(plan, report.balance, config.reconcile),
  ]
  expect(checks).toHaveLength(4)
  expect(checks.every((c) => c.ok)).toBe(true)
})

test("keeps Checkin's gross with a net Fiken accepts", () => {
  // From a real report: Fiken rejected net 2 139,75 with gross 2 674,74 (expected 2 139,79).
  const line = {
    description: "Gebyr",
    netPrice: 213975,
    vat: 53494,
    vatType: "HIGH",
    account: "4300",
  } as const
  const plan = {
    month: "2026-09",
    date: "2026-09-30",
    sale: { lines: [], gross: 0 },
    purchase: { lines: [line], gross: 267469 },
    expectedPayout: -267469,
  }
  const { plan: booked, adjusted } = applyCheckinVat(
    plan,
    new Map([["2711", 53499]]),
    config.reconcile,
  )
  expect(booked.purchase.lines[0]).toMatchObject({ netPrice: 213979, vat: 53495 })
  expect(booked.purchase.gross).toBe(267474)
  expect(adjusted).toHaveLength(1)
})

test("flags VAT on the wrong side of Checkin's for Skatteetaten", () => {
  const plan = (saleVat: number, purchaseVat: number) => ({
    month: "2026-09",
    date: "2026-09-30",
    sale: {
      lines: [
        {
          description: "TDC",
          netPrice: 400000,
          vat: saleVat,
          vatType: "HIGH" as const,
          account: "3000",
        },
      ],
      gross: 0,
    },
    purchase: {
      lines: [
        {
          description: "Gebyr",
          netPrice: 4000,
          vat: purchaseVat,
          vatType: "HIGH" as const,
          account: "4300",
        },
      ],
      gross: 0,
    },
    expectedPayout: 0,
  })
  const balance = new Map([
    ["2701", -100000],
    ["2711", 1000],
  ])
  const ok = (p: ReturnType<typeof plan>) =>
    verifyPlan(p, balance, config.reconcile).map((c) => c.ok)
  // More output VAT and less input VAT than Checkin is fine.
  expect(ok(plan(100003, 997))).toEqual([true, true])
  // Less output VAT or more input VAT than Checkin is flagged.
  expect(ok(plan(99997, 1003))).toEqual([false, false])
})

test("a wrong VAT type in the recipe fails the checks", async () => {
  const report = await parseReportPdf(MARCH_2026)
  const wrong = Config.parse({
    ...config,
    purchase: {
      ...config.purchase,
      lines: config.purchase.lines.map((l) => ({ ...l, vatType: "NONE" })),
    },
  })
  const plan = buildPlan(toReport("2026-03", report.movements, wrong), wrong)
  expect(
    verifyPlan(plan, report.balance, wrong.reconcile).find((c) => c.label.includes("2711"))?.ok,
  ).toBe(false)
  expect(verifyNet(plan, report.balance, wrong.reconcile)[0]?.ok).toBe(false)
})

test("reconciles payouts and balance of the Checkin account in Fiken", async () => {
  const { report, plan } = await marchPlan()

  // 52 000 at the end of February, 50 000 moved to the bank by superføring in March.
  const ok = reconcile(
    plan,
    report,
    { code: "1960:10001", start: 5200000, end: 200000 },
    config.reconcile,
  )
  expect(ok.map((c) => c.ok)).toEqual([true, true])

  // A missing superføring shows up in both checks.
  const missing = reconcile(
    plan,
    report,
    { code: "1960:10001", start: 5200000, end: 2200000 },
    config.reconcile,
  )
  expect(missing.map((c) => c.ok)).toEqual([false, false])
  expect(missing[0]!.expected - missing[0]!.actual).toBe(-2000000)
})

test("rejects PDFs without result accounts", async () => {
  const empty = checkinPdf({ period: "mars 2026", balance: [], result: [], payouts: [] })
  await expect(parseReportPdf(empty)).rejects.toThrow(/ingen resultatkontoer/)
})

test("accounts not covered by the recipe stop the run", () => {
  expect(Object.fromEntries(parseAmountsArg("3000=49380,4300=1234.40"))).toEqual({
    "3000": 4938000,
    "4300": 123440,
  })
  expect(() => toReport("2026-03", parseAmountsArg("3000=100,3002=50"), config)).toThrow(/3002/)
})

test("books on our own accounts regardless of the Checkin account numbers", () => {
  const ours = Config.parse({
    ...config,
    purchase: {
      account: "4300",
      lines: [
        { description: "Checkin gebyr", vatType: "HIGH", from: ["4300", "4302"] },
        { description: "Transaksjonsgebyr", vatType: "NONE", from: ["4335"] },
      ],
    },
  })
  const plan = buildPlan(
    toReport("2026-03", parseAmountsArg("3000=1000,4300=100,4302=20,4335=30"), ours),
    ours,
  )
  expect(plan.purchase.lines.map((l) => [l.account, l.description, l.netPrice, l.vatType])).toEqual(
    [
      ["4300", "Checkin gebyr", 12000, "HIGH"],
      ["4300", "Transaksjonsgebyr", 3000, "NONE"],
    ],
  )
})

test("config validation", () => {
  expect(Config.safeParse({ ...config, bankAccount: "1920-10001" }).success).toBe(false)
  const dup = { ...config, ignore: ["4335"] }
  expect(Config.safeParse(dup).success).toBe(false)
  const withAccrual = {
    ...config,
    sale: { ...config.sale, accrual: { account: "2965", startDate: "2026-10-01", periods: 1 } },
  }
  expect(Config.safeParse(withAccrual).success).toBe(true)
})
