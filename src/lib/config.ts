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
    /** Checkin accounts in the report that we deliberately don't book. */
    ignore: z.array(CheckinAccount).default([]),
    inbox: z.object({
      /** Substring identifying the monthly accounting report, e.g. "Regnskapsbilag". */
      reportName: z.string().min(1),
    }),
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
