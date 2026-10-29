import { z } from "zod"
import { VatType } from "./fiken.ts"

const AccountCode = z
  .string()
  .regex(/^\d{4}(:\d{5})?$/, "Expected an account code like 3000 or 1920:10001")
export const IsoDate = z.iso.date()
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM")

const AccrualConfig = z.object({
  /** Balance account to accrue against, e.g. 2965 (sales) or 1749 (purchases). */
  account: AccountCode,
  /** First month of the accrual. */
  startDate: IsoDate,
  periods: z.int().min(1).max(120),
})

const CheckinAccount = z.string().regex(/^\d{4}$/, "Expected a 4-digit Checkin account")

/** One line on the Fiken sale/purchase, e.g. "Checkin gebyr" with 25 % VAT. */
const Line = z.object({
  /** Line text in Fiken. */
  description: z.string().min(1).max(200),
  vatType: VatType,
  /**
   * Which amounts in the Checkin report make up this line, identified by the account
   * Checkin prints them on. Only used to find the amounts; Fiken gets our own account.
   */
  from: z.array(CheckinAccount).min(1),
})

/**
 * A Fiken contact, by contact id or Norwegian org. number (9 digits). Setting it puts the entry in
 * the contact's ledger (reskontro): customers 1500:XXXXX, suppliers 2400:XXXXX.
 */
const ContactRef = z
  .object({
    contactId: z.int().positive().optional(),
    organizationNumber: z
      .string()
      .regex(/^\d{9}$/, "Expected a 9-digit org. number")
      .optional(),
  })
  .refine((c) => (c.contactId === undefined) !== (c.organizationNumber === undefined), {
    message: "Give exactly one of contactId or organizationNumber",
  })
export type ContactRef = z.infer<typeof ContactRef>

/** VAT rate in percent on the hotel invoice. */
export const VatRate = z.union([z.literal(25), z.literal(15), z.literal(12), z.literal(0)])
export type VatRate = z.infer<typeof VatRate>

/** A case-insensitive regular expression, checked when the recipe is read. */
const Pattern = z.string().refine(
  (s) => {
    try {
      new RegExp(s, "i")
      return true
    } catch {
      return false
    }
  },
  { message: "Not a valid regular expression" },
)

const CategoryId = z.string().regex(/^[a-z][a-z0-9-]*$/, "Expected a short id like crew")

/** A category on the hotel invoice; becomes one purchase line per VAT rate. */
const HotelCategory = z.object({
  id: CategoryId,
  /** Line text in Fiken, e.g. "Lokaler og stand". */
  label: z.string().min(1).max(150),
  /** Our expense account. Can be changed per invoice in the review. */
  account: AccountCode,
  /**
   * Deduct the input VAT: true for every rate, false for none, or the rates to deduct, e.g. [12]
   * for rooms (12 %) with breakfast (25 %) without deduction. Lines without deduction are booked
   * as the gross without VAT.
   */
  deduct: z.union([z.boolean(), z.array(VatRate)]),
  /** Line text per rate, replacing the generated one, e.g. { "25": "Frokost, uten fradrag" }. */
  lineText: z.partialRecord(z.enum(["25", "15", "12", "0"]), z.string().min(1).max(200)).optional(),
})

/**
 * Proposes a category for a line. Every condition given must hold; the first rule that matches
 * wins. The user can move a bill or a line in the review before booking.
 */
const HotelRule = z.object({
  category: CategoryId,
  /** Section on the invoice, e.g. "POS - Banquet" (case-insensitive). */
  section: z.string().min(1).optional(),
  /** VAT rate of the line. Room lines with breakfast have no single rate. */
  rate: VatRate.optional(),
  /** Pattern for the item text, e.g. "pizza|coffee". */
  text: Pattern.optional(),
  /** Pattern that any line in the same bill must match, e.g. beer or wine for the party bills. */
  billText: Pattern.optional(),
  /** Quantity from "889 x …" in the text. */
  minCount: z.int().min(1).optional(),
  maxCount: z.int().min(1).optional(),
})

/** The hotel's conference invoice: one supplier purchase with a line per category and rate. */
const HotelConfig = z
  .object({
    /** The hotel as supplier (leverandørreskontro 2400:XXXXX). */
    supplier: z.object({
      organizationNumber: z.string().regex(/^\d{9}$/, "Expected a 9-digit org. number"),
    }),
    categories: z.array(HotelCategory).min(1),
    rules: z.array(HotelRule),
  })
  .superRefine((hotel, ctx) => {
    const ids = new Set<string>()
    for (const c of hotel.categories) {
      if (ids.has(c.id))
        ctx.addIssue({ code: "custom", message: `Category ${c.id} is defined twice` })
      ids.add(c.id)
    }
    for (const r of hotel.rules) {
      if (!ids.has(r.category))
        ctx.addIssue({ code: "custom", message: `Rule names unknown category ${r.category}` })
    }
  })
export type HotelConfig = z.infer<typeof HotelConfig>

const Side = z.object({
  /** Our Fiken account for all lines, e.g. 3000 for the sale and 4300 for the purchase. */
  account: AccountCode,
  lines: z.array(Line),
  accrual: AccrualConfig.optional(),
})

export const Config = z
  .object({
    /**
     * Default Fiken company slug (see `pnpm foring companies`), used when the user has access to
     * it. Otherwise the web app asks, and the CLI needs `--company`.
     */
    companySlug: z.string().min(1).optional(),
    /** Fiken account code for "Utenlandsk bankkonto / betalingstjeneste Checkin". */
    checkinAccount: AccountCode,
    /** Fiken account code of the bank account Checkin pays out to. */
    bankAccount: AccountCode,
    sale: Side.extend({
      lines: z.array(Line).min(1),
      /** Customer on the sale, e.g. Checkin AS. Optional. */
      customer: ContactRef.optional(),
    }),
    purchase: Side.extend({
      /** Supplier on the purchase, e.g. Checkin AS. Makes it a supplier purchase (2400:XXXXX). Optional. */
      supplier: ContactRef.optional(),
    }),
    /**
     * Reconciles our Checkin account (checkinAccount) in Fiken against the report.
     * Accounts are the ones Checkin prints in "Balansekontoer".
     */
    reconcile: z
      .object({
        /** Where Checkin shows money paid out to our bank ("Bankinnskudd"); net movement = paid out this month. */
        payoutAccounts: z.array(CheckinAccount).default(["1920"]),
        /** Accounts whose closing balance together is what Checkin holds for us. Leave out to skip. */
        balanceAccounts: z.array(CheckinAccount).optional(),
        /** Book the gross Checkin charged (VAT ≤ 1 kr from 25 %) and derive the net from it, so the Checkin account matches to the øre. */
        useCheckinVat: z.boolean().default(true),
        /** Account for øreavrunding on months booked before useCheckinVat (Checkin's net, Fiken's VAT). */
        roundingAccount: AccountCode.default("7740"),
        /** Checkin's VAT accounts per VAT type, used to cross-check our VAT. */
        outputVat: z.partialRecord(VatType, CheckinAccount).default({ HIGH: "2701" }),
        inputVat: z.partialRecord(VatType, CheckinAccount).default({ HIGH: "2711" }),
      })
      .prefault({}),
    /** Checkin accounts in the report that we deliberately don't book, result or balance. */
    ignore: z.array(CheckinAccount).default([]),
    /**
     * Event name Checkin prints before the year, e.g. "TDC" for "TDC 2026". The report is read as
     * one event, so a report naming two years (e.g. TDC 2026 and TDC 2027) fails a check.
     */
    event: z.string().min(1).optional(),
    inbox: z.object({
      /** Substring identifying the monthly accounting report, e.g. "Regnskapsbilag". */
      reportName: z.string().min(1),
    }),
    /** The hotel's conference invoice. Optional. */
    hotel: HotelConfig.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>(config.ignore)
    for (const line of [...config.sale.lines, ...config.purchase.lines]) {
      for (const account of line.from) {
        if (seen.has(account))
          ctx.addIssue({
            code: "custom",
            message: `Checkin account ${account} is used more than once`,
          })
        seen.add(account)
      }
    }
  })
export type Config = z.infer<typeof Config>

/** Validates a config object, with readable errors. `source` names it in the message. */
export function parseConfig(json: unknown, source: string): Config {
  const result = Config.safeParse(json)
  if (!result.success)
    throw new Error(`Invalid config ${source}:\n${z.prettifyError(result.error)}`)
  return result.data
}
