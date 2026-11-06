// How utlegg were booked before: picking them out of Fiken's purchases and journal entries, and the
// summary per account and VAT. Made-up data.

import { describe, expect, test } from "vitest"
import type { JournalEntry, PurchaseResult } from "../src/lib/fiken.ts"
import { pastUtlegg, utleggPractice } from "../src/lib/utlegg-history.ts"

const purchase = (p: Partial<PurchaseResult> & { purchaseId: number }): PurchaseResult => ({
  date: "2030-10-20",
  lines: [],
  ...p,
})

const PURCHASES: PurchaseResult[] = [
  // A person: no organisation number.
  purchase({
    purchaseId: 1,
    supplier: { contactId: 10, name: "Kari Testesen" },
    kind: "supplier",
    paid: true,
    payments: [{ account: "1920:10001", amount: 51200 }],
    lines: [{ account: "7140", vatType: "LOW", netPrice: 45714, vat: 5486 }],
  }),
  // A company: not an utlegg.
  purchase({
    purchaseId: 2,
    supplier: { contactId: 11, name: "Hotel AS", organizationNumber: "995857480" },
    lines: [{ account: "6300", vatType: "HIGH", netPrice: 100000, vat: 25000 }],
  }),
  // Named as an utlegg, booked as a cash purchase.
  purchase({
    purchaseId: 3,
    identifier: "Utlegg pizza crew",
    kind: "cash_purchase",
    currency: "NOK",
    lines: [{ account: "5990", vatType: "NONE", netPrice: 245050, vat: 0 }],
  }),
  // Booked with the shop as supplier; only the line says it was an utlegg.
  purchase({
    purchaseId: 5,
    supplier: { contactId: 12, name: "Butikk AS", organizationNumber: "999999999" },
    lines: [
      {
        account: "6551",
        vatType: "NONE",
        netPrice: 100000,
        vat: 0,
        description: "Utlegg - printer",
      },
    ],
  }),
  purchase({
    purchaseId: 4,
    deleted: true,
    supplier: { contactId: 10, name: "Kari Testesen" },
    lines: [{ account: "7140", vatType: "LOW", netPrice: 1, vat: 0 }],
  }),
]

const ENTRIES: JournalEntry[] = [
  {
    journalEntryId: 50,
    date: "2030-10-05",
    description: "Teip",
    transactionType: "Kontantutlegg",
    lines: [
      { account: "6560", amount: 31120, vatCode: "1" },
      { account: "2711", amount: 7780 },
      { account: "2910", amount: -38900 },
    ],
  },
  { journalEntryId: 51, transactionType: "Fri", lines: [{ account: "1920", amount: 1 }] },
  {
    journalEntryId: 52,
    transactionType: "Kontantutlegg",
    offsetTransactionId: 99,
    lines: [{ account: "6560", amount: 1 }],
  },
]

describe("utlegg booked before", () => {
  const items = pastUtlegg(PURCHASES, ENTRIES)

  test("purchases from people or named as utlegg, and Kontantutlegg; not companies, deleted or cancelled", () => {
    expect(items.map((i) => [i.source, i.id])).toEqual([
      ["kontantutlegg", 50],
      ["purchase", 1],
      ["purchase", 3],
      ["purchase", 5],
    ])
  })

  test("how each was paid: a bank payment, or the debt account of Fiken's utlegg flow", () => {
    expect(items.map((i) => i.paidFrom)).toEqual([["2910"], ["1920:10001"], [], []])
  })

  test("a summary of the cost lines per account and VAT, leaving out VAT and debt", () => {
    expect(utleggPractice(items)).toEqual([
      { account: "5990", vat: "NONE", count: 1, net: 245050, vatAmount: 0 },
      { account: "6551", vat: "NONE", count: 1, net: 100000, vatAmount: 0 },
      { account: "6560", vat: "1", count: 1, net: 31120, vatAmount: 0 },
      { account: "7140", vat: "LOW", count: 1, net: 45714, vatAmount: 5486 },
    ])
  })
})
