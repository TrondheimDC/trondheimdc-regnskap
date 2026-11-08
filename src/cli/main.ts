#!/usr/bin/env -S npx tsx
import "./env.ts"
// Books the monthly Checkin accounting report in Fiken: sale, purchase and a fri postering per payout.
// Run `pnpm foring help` for usage.

import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import {
  auditBooked,
  book,
  bookable,
  bookRounding,
  type Existing,
  findReportDocument,
  inspectFiken,
  listReportDocuments,
  type MappingRow,
  PARTS,
  type Part,
  type Parts,
  pickCompany,
  prepare,
  type ReportSource,
} from "../lib/booking.ts"
import { parseAmountsArg, parseReportPdf } from "../lib/checkin.ts"
import {
  type Config,
  type HotelConfig,
  Month,
  parseConfig,
  type UtleggConfig,
} from "../lib/config.ts"
import { Fiken, type InboxDocument } from "../lib/fiken.ts"
import {
  groupByBill,
  type HotelChoices,
  parseAccountsArg,
  parseHotelInvoicePdf,
  parseMovesArg,
} from "../lib/hotel.ts"
import {
  bookHotel,
  type HotelSource,
  hotelBlockers,
  inspectHotel,
  listHotelInvoices,
  prepareHotel,
} from "../lib/hotel-booking.ts"
import { Ed25519PublicKey, type MinTdcResult, summarizeMinTdc } from "../lib/min-tdc.ts"
import { formatMoney, formatMonthNo, formatNok } from "../lib/plan.ts"
import { parseRatesArg, parseRowChoicesArg, type UtleggChoices } from "../lib/utlegg.ts"
import {
  bookUtlegg,
  describePerson,
  describeUpdate,
  inspectUtlegg,
  listUtleggDocuments,
  prepareUtlegg,
  readUtleggSource as readUtleggPdf,
  type UtleggSource,
  utleggBlockers,
} from "../lib/utlegg-booking.ts"
import { pastUtlegg, utleggPractice } from "../lib/utlegg-history.ts"
import { type Check, explainRounding, isRoundingCheck } from "../lib/verify.ts"
import { createAuth, hasCredentials, login, logout } from "./auth.ts"

const HELP = `Usage: pnpm foring <command> [options]

Commands:
  report [file.pdf]   Book a monthly Checkin regnskapsbilag as a sale, a purchase and
                      a fri postering (Checkin account -> bank) per payout.
                      Without a file the PDF is fetched from the Fiken inbox.
  check [file.pdf]    Check a month that is already booked against its regnskapsbilag:
                      sale, purchase and payouts in Fiken. Without a file, give --month
                      or --inbox-doc (used documents too). If the month was booked with
                      Fiken's VAT and the Checkin account is a few øre off, --mode create
                      books an øreavrunding fri postering (after confirmation).
  hotell [file.pdf]   Book the hotel's conference invoice as one supplier purchase (unpaid,
                      with due date and KID): a line per category and VAT rate.
                      Without a file the hotel's EHF is fetched from Fiken.
  utlegg [file.pdf]   Book an utleggsrapport from the utlegg form as one supplier purchase
                      (unpaid, with due date) from the person: a line per receipt.
                      Without a file the report is fetched from the Fiken inbox.
  utlegg-history [year]
                      Read-only: how utlegg were booked in Fiken that year (default: this
                      year and last): purchases from people and Kontantutlegg, with accounts,
                      VAT, currency and payment, and a summary per account and VAT.
  companies           List Fiken companies the token can access
  accounts            List bank accounts in Fiken (to find account codes)
  chart [range]       List the chart of accounts in Fiken (default 4000-8999)
  inbox               List unused documents in the Fiken inbox
  contacts [name]     List Fiken contacts matching a name (default "checkin")

Options:
  --mode <m>          dry-run (default), draft or create
  --yes               Skip the confirmation prompt (only if all checks pass)
  --only <parts>      report: book only these, comma-separated: salg, kjop, utbetalinger
                      (default: whatever is not in Fiken yet)
  --month <YYYY-MM>   Report month (report: read from the PDF if not given)
  --amounts <list>    report: net amounts per Checkin account instead of the PDF,
                      e.g. "3000=427521.63,4300=5163.44,4335=24711.53"
  --inbox-doc <id>    Fiken inbox document to read/attach (default: auto-detect)
  --ehf <id>          hotell: Fiken EHF document to read/attach (default: the hotel's unprocessed one)
  --move <list>       hotell: move bills or lines to another category, comma-separated,
                      e.g. "NO121S0000033=servering,#57=crew"
  --account <list>    hotell, utlegg: account per category instead of the recipe's, e.g. "crew=5990"
  --category <list>   utlegg: category per receipt, e.g. "#2=materiell,#3=reise"
  --rate <list>       utlegg: VAT rate per receipt, e.g. "#3=12,#4=0"
  --no-attach         Do not attach any inbox document
  --offline           dry-run: skip all calls to Fiken (needs a file or --amounts)
  --company <slug>    Fiken company (default: companySlug in the config, if you have access)
  --config <path>     Config file (default: regnskap.config.json)

Login:
  login               Log in to Fiken in the browser (OAuth); the token is stored and renewed
  logout              Delete the stored token

Environment (.env): FIKEN_CLIENT_ID (OAuth app), or FIKEN_API_TOKEN (personal key)
`

const { values: rawOpts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "dry-run" },
    yes: { type: "boolean", short: "y", default: false },
    only: { type: "string" },
    month: { type: "string" },
    amounts: { type: "string" },
    "inbox-doc": { type: "string" },
    ehf: { type: "string" },
    move: { type: "string" },
    account: { type: "string" },
    category: { type: "string" },
    rate: { type: "string" },
    "no-attach": { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    company: { type: "string" },
    config: { type: "string", default: "regnskap.config.json" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const Options = z.object({
  mode: z.enum(["dry-run", "draft", "create"]),
  yes: z.boolean(),
  only: z
    .string()
    .transform((s) => s.split(",").map((p) => p.trim().toLowerCase()))
    .pipe(z.array(z.enum(["salg", "kjop", "kjøp", "utbetalinger"])).min(1))
    .optional(),
  month: Month.optional(),
  amounts: z.string().optional(),
  "inbox-doc": z.coerce.number().int().positive().optional(),
  ehf: z.coerce.number().int().positive().optional(),
  move: z.string().optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  rate: z.string().optional(),
  "no-attach": z.boolean(),
  offline: z.boolean(),
  company: z.string().min(1).optional(),
  config: z.string(),
  help: z.boolean(),
})

const parsedOpts = Options.safeParse(rawOpts)
if (!parsedOpts.success) fail(`Invalid options:\n${z.prettifyError(parsedOpts.error)}`)
const opts = parsedOpts.data
const mode = opts.mode
const [command, ...args] = positionals

async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8").catch(() => fail(`Config file ${path} not found.`))
  return parseConfig(JSON.parse(raw), path)
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function step(message: string) {
  console.log(`  ✓ ${message}`)
}

function warn(message: string) {
  console.log(`  ✗ ${message}`)
}

function printLines(
  title: string,
  lines: {
    account: string
    description?: string
    netPrice: number
    vat?: number
    vatType: string
  }[],
  gross: number,
  currency = "NOK",
) {
  const money = (n: number) => formatMoney(n, currency)
  console.log(`\n${title}`)
  for (const l of lines) {
    console.log(
      `  ${l.account}  ${(l.description ?? "").padEnd(24)} netto ${money(l.netPrice).padStart(16)}  ` +
        `mva ${money(l.vat ?? 0).padStart(14)}  (${l.vatType})`,
    )
  }
  console.log(`  ${"Sum inkl. mva".padEnd(30)} ${money(gross).padStart(16)}`)
}

function printAccrual(accrual: Config["sale"]["accrual"]) {
  if (accrual) {
    console.log(
      `  Periodiseres mot ${accrual.account}, start ${accrual.startDate}, ${accrual.periods} måned(er)`,
    )
  }
}

const PART_LABELS: Record<Part, string> = {
  sale: "Salg",
  purchase: "Kjøp",
  transfers: "Utbetalinger",
}
const PART_ARGS: Record<string, Part> = {
  salg: "sale",
  kjop: "purchase",
  kjøp: "purchase",
  utbetalinger: "transfers",
}

function describeExisting(e: Existing) {
  return e.status === "draft"
    ? `ligger som utkast (id ${e.draftId})`
    : `er bokført (${e.vouchers.map((v) => `«${v.number ?? ""}» id ${v.id}`).join(", ")})`
}

function printMapping(rows: MappingRow[]) {
  console.log("\nSlik er bilaget lest (netto endring per Checkin-konto og hvor det føres)")
  for (const { checkinAccount, net, target } of rows) {
    const text =
      target === "ignored"
        ? "(ignoreres)"
        : target === "unmapped"
          ? "(mangler i oppskriften)"
          : `→ ${target.side === "sale" ? "salg" : "kjøp"}, ${target.account} "${target.description}"`
    console.log(`  ${checkinAccount}  ${formatNok(net).padStart(16)}  ${text}`)
  }
}

/** Prints checks with ✓/✗ and returns whether all passed. */
function printChecks(checks: Check[]): boolean {
  for (const c of checks) {
    const amounts = `${c.source ?? "beregnet"} ${formatMoney(c.expected, c.currency)}, ${c.reference ?? "Checkin"} ${formatMoney(c.actual, c.currency)}`
    const text = `${c.label}: ${c.detail ?? amounts}`
    if (c.ok && c.note) {
      console.log(`  ! ${text}`)
      console.log(`    ${c.note}`)
    } else if (c.ok) {
      step(text)
    } else {
      warn(c.detail ? text : `${text} (avvik ${formatMoney(c.expected - c.actual, c.currency)})`)
      if (c.hint) console.log(`    ${c.hint}`)
    }
  }
  return checks.every((c) => c.ok)
}

/** Asks before anything is written. Returns false if the user says no. */
async function confirm(question: string, checksOk: boolean): Promise<boolean> {
  if (opts.yes) {
    if (!checksOk)
      fail("Some checks failed; refusing to continue with --yes. Run without --yes to review.")
    return true
  }
  if (!process.stdin.isTTY)
    fail("Not running in a terminal; pass --yes to confirm (only allowed when all checks pass)")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const prompt = checksOk
    ? `\n${question} [j/N] `
    : `\nNoen kontroller feilet. ${question} likevel? Skriv "ja" for å fortsette: `
  const answer = (await rl.question(prompt)).trim().toLowerCase()
  rl.close()
  return checksOk ? ["j", "ja", "y", "yes"].includes(answer) : answer === "ja"
}

async function fiken(config?: Config): Promise<Fiken> {
  const auth = await createAuth()
  const baseUrl = process.env.FIKEN_API_URL
  if (!config) return new Fiken(auth, "", baseUrl)
  const companies = await new Fiken(auth, "", baseUrl).companies()
  const slugs = companies.map((c) => c.slug).join(", ")
  if (opts.company && !companies.some((c) => c.slug === opts.company))
    fail(`No access to Fiken company "${opts.company}". Available: ${slugs}`)
  const company = pickCompany(companies, [opts.company, config.companySlug])
  if (!company)
    fail(
      companies.length === 0
        ? "The Fiken user has no companies"
        : `Several Fiken companies; choose one with --company: ${slugs}`,
    )
  return new Fiken(auth, company.slug, baseUrl)
}

/** Finds a Checkin document in the Fiken inbox, by --inbox-doc or by name (and month, if known). */
async function findInboxDocument(
  client: Fiken,
  nameFilter: string,
  month?: string,
): Promise<InboxDocument> {
  if (opts["inbox-doc"]) {
    const id = opts["inbox-doc"]
    const doc = (await client.inbox({ status: "all" })).find((d) => d.documentId === id)
    if (!doc) fail(`Inbox document ${id} not found`)
    return doc
  }
  const { match, candidates } = await findReportDocument(client, nameFilter, month)
  if (match) return match
  const list = candidates
    .map((d) => `  ${d.documentId}  ${d.name} (${d.filename}, ${d.createdAt})`)
    .join("\n")
  fail(
    candidates.length === 0
      ? `No unused inbox document matching "${nameFilter}". Use --inbox-doc <id> or --no-attach.`
      : `Several inbox documents match "${nameFilter}", pick one with --inbox-doc <id>:\n${list}`,
  )
}

/** Reads the report from --amounts, a local PDF, or the Fiken inbox. */
async function readSource(client: Fiken | undefined, config: Config): Promise<ReportSource> {
  if (opts.amounts) {
    return {
      month: opts.month,
      movements: parseAmountsArg(opts.amounts),
      balance: new Map(),
      closing: new Map(),
      payouts: [],
      boxes: {},
      description: "--amounts",
    }
  }

  const file = args[0]
  if (file) {
    const data = await readFile(file).catch(() => fail(`File ${file} not found`))
    const parsed = await parseReportPdf(new Uint8Array(data))
    return { ...parsed, description: file }
  }

  if (!client)
    fail(
      "Give a PDF file or --amounts, or log in with `pnpm foring login` to read the PDF from the Fiken inbox",
    )
  const doc = await findInboxDocument(client, config.inbox.reportName, opts.month)
  const parsed = await parseReportPdf(await client.downloadInboxDocument(doc))
  return { ...parsed, doc, description: `Fiken-innboks ${doc.documentId} "${doc.name}"` }
}

async function report() {
  const config = await loadConfig(opts.config)
  const client =
    opts.offline || (mode === "dry-run" && !(await hasCredentials()))
      ? undefined
      : await fiken(config)

  // 1–2. Read and map to the recipe; checks against the report itself.
  const source = await readSource(client, config)
  const prepared = prepare(source, config, opts.month ?? source.month)
  const { plan, month, reference } = prepared

  console.log(`Checkin regnskapsbilag ${formatMonthNo(month)} → Fiken (${mode})`)
  console.log(`Kilde: ${source.description}`)
  printMapping(prepared.mapping)

  console.log(
    `\nBilagsdato ${plan.date}, betalt til/fra ${config.checkinAccount}, referanse "${reference}"`,
  )
  printLines("Salg (Annet salg)", plan.sale.lines, plan.sale.gross)
  printAccrual(config.sale.accrual)
  if (plan.purchase.lines.length > 0) {
    printLines("Kjøp", plan.purchase.lines, plan.purchase.gross)
    printAccrual(config.purchase.accrual)
  }
  for (const r of prepared.adjusted) console.log(`  Øreavrunding: ${explainRounding(r)}`)
  console.log(`\nSalg − kjøp: ${formatNok(plan.expectedPayout)}`)

  console.log("\nKontroller mot bilaget")
  if (prepared.checks.length === 0) console.log("  (ingen kontoer i bilaget å kontrollere mot)")
  for (const p of source.payouts)
    console.log(`  · Utbetaling ${p.voucher} bokført ${p.date}: ${formatNok(p.amount)}`)
  let checksOk = printChecks(prepared.checks)

  if (!client) {
    console.log("\n(Ingen kontakt med Fiken: ikke innlogget eller --offline er satt)")
    return
  }

  // 3. Read-only checks against Fiken.
  const state = await inspectFiken(client, config, prepared, { attach: !opts["no-attach"] })
  console.log(
    `\nFiken: ${state.company.name} (${state.company.slug})${state.company.testCompany ? " [testselskap]" : ""}`,
  )
  if (state.doc) step(`Vedlegg: ${state.doc.documentId} "${state.doc.name}"`)
  if (state.customer)
    step(
      `Kunde på salget: ${state.customer.name} (${state.customer.accountCode ?? state.customer.contactId})`,
    )
  if (state.supplier)
    step(
      `Leverandør på kjøpet: ${state.supplier.name} (${state.supplier.accountCode ?? state.supplier.contactId})`,
    )
  for (const b of state.blockers) warn(b)
  if (state.blockers.length === 0) step("Bankkontoene finnes")
  for (const side of ["sale", "purchase"] as const) {
    const e = state.existing[side]
    if (e) step(`${PART_LABELS[side]} «${reference}» ${describeExisting(e)}, føres ikke igjen`)
  }

  console.log(`\nUtbetalinger (${config.checkinAccount} → ${config.bankAccount})`)
  if (state.transfers.length === 0) console.log("  (ingen utbetalinger i bilaget)")
  for (const t of state.transfers) {
    const line = `${t.date}  ${formatNok(t.amount).padStart(16)}  bilag ${t.voucher}`
    if (t.existing) step(`${line}  allerede ført (id ${t.existing.journalEntryId})`)
    else console.log(`  + ${line}  føres`)
  }

  console.log(
    `\nAvstemming av ${config.checkinAccount} (${formatNok(state.checkin.start)} → ${formatNok(state.checkin.end)} i Fiken før føring)`,
  )
  if (state.checks.length === 0)
    console.log("  (fant ingen utbetalings- eller saldokontoer i bilaget å avstemme mot)")
  checksOk = printChecks(state.checks) && checksOk

  if (state.blockers.length > 0) fail("Kan ikke føre, se ✗ over.")

  // What to book: by default everything not in Fiken yet; --only narrows it.
  const open = bookable(prepared, state)
  const only = opts.only?.map((p) => PART_ARGS[p]!)
  for (const part of only ?? [])
    if (!open[part]) fail(`${PART_LABELS[part]} ligger allerede i Fiken eller er tomt`)
  const parts = Object.fromEntries(
    PARTS.map((p) => [p, only ? only.includes(p) : open[p]]),
  ) as Parts
  console.log(
    `\nFøres: ${PARTS.filter((p) => parts[p])
      .map((p) => PART_LABELS[p].toLowerCase())
      .join(", ")}`,
  )
  for (const p of PARTS.filter((p) => open[p] && !parts[p]))
    console.log(`  (${PART_LABELS[p].toLowerCase()} føres ikke nå, se --only)`)

  if (mode === "dry-run") {
    console.log("\nDry run: ingenting er skrevet til Fiken. Bruk --mode draft eller --mode create.")
    return
  }

  // 4–5. Confirm, then write.
  const chosen = [
    parts.sale && "salg",
    parts.purchase && "kjøp",
    parts.transfers && (mode === "draft" ? "åpne fri posteringer" : "fri posteringer"),
  ].filter(Boolean)
  const what = `${mode === "draft" ? "Lag utkast for" : "Bokfør"} ${chosen.join(", ")} i Fiken`
  if (!(await confirm(what, checksOk))) {
    console.log("Avbrutt, ingenting er skrevet til Fiken.")
    return
  }

  console.log("")
  const result = await book(client, config, prepared, state, mode, parts, step)
  if (mode === "draft" && (config.sale.accrual || config.purchase.accrual)) {
    console.log(
      "\nUtkast kan ikke periodiseres herfra. Periodiser linjene når du bokfører utkastene i Fiken.",
    )
  }
  if (result.balance) {
    const { actual, expected } = result.balance
    if (actual === expected)
      step(`Saldo ${config.checkinAccount} per ${plan.date}: ${formatNok(actual)}`)
    else
      warn(
        `Saldo ${config.checkinAccount} per ${plan.date} er ${formatNok(actual)}, forventet ${formatNok(expected)}. Sjekk føringene i Fiken.`,
      )
  }
  console.log("\nFerdig.")
}

/** Checks a booked month: what is in Fiken against the report. Read-only. */
async function check() {
  const config = await loadConfig(opts.config)
  const client = await fiken(config)

  let source: ReportSource
  if (args[0] || opts["inbox-doc"]) {
    source = await readSource(client, config)
  } else {
    if (!opts.month) fail("Give --month <YYYY-MM>, --inbox-doc <id> or a PDF file")
    const docs = (await listReportDocuments(client, config.inbox.reportName)).filter(
      (d) => d.month === opts.month,
    )
    const doc = docs[0]
    if (!doc || docs.length > 1)
      fail(
        docs.length === 0
          ? `No "${config.inbox.reportName}" document for ${opts.month} in the inbox`
          : `Several documents for ${opts.month}, pick one with --inbox-doc <id>:\n${docs.map((d) => `  ${d.documentId}  ${d.name}`).join("\n")}`,
      )
    const parsed = await parseReportPdf(await client.downloadInboxDocument(doc))
    source = { ...parsed, doc, description: `Fiken-innboks ${doc.documentId} "${doc.name}"` }
  }
  const prepared = prepare(source, config, opts.month ?? source.month)
  const { plan, month } = prepared

  console.log(`Kontroll av ført måned ${formatMonthNo(month)} i Fiken`)
  console.log(`Kilde: ${source.description}`)
  printLines("Salg ifølge bilaget", plan.sale.lines, plan.sale.gross)
  if (plan.purchase.lines.length > 0)
    printLines("Kjøp ifølge bilaget", plan.purchase.lines, plan.purchase.gross)

  const audit = await auditBooked(client, config, prepared)
  for (const [title, vouchers] of [
    ["Salg", audit.booked.sales],
    ["Kjøp", audit.booked.purchases],
  ] as const) {
    if (vouchers.length === 0) console.log(`\n${title} i Fiken: fant ingen`)
    for (const v of vouchers)
      printLines(
        `${title} i Fiken: "${v.number ?? ""}" ${v.date ?? ""} (id ${v.id})`,
        v.lines,
        v.gross,
      )
  }

  console.log(`\nUtbetalinger (${config.checkinAccount} → ${config.bankAccount})`)
  if (audit.transfers.length === 0) console.log("  (ingen utbetalinger i bilaget)")
  for (const t of audit.transfers) {
    const line = `${t.date}  ${formatNok(t.amount).padStart(16)}  bilag ${t.voucher}`
    if (t.existing) step(`${line}  ført (id ${t.existing.journalEntryId})`)
    else warn(`${line}  mangler i Fiken`)
  }
  if (audit.bank) {
    const b = audit.bank
    console.log(
      `\nBankavstemming (${b.accountCode} avstemt til ${b.reconciledDate ?? "aldri"}): koble i Fiken`,
    )
    for (const p of b.pending) warn(`${p.date}  ${formatNok(p.amount).padStart(16)}`)
    console.log(`  ${b.url}`)
  }

  console.log(
    `\nKontroller (${config.checkinAccount}: ${formatNok(audit.checkin.start)} → ${formatNok(audit.checkin.end)} i Fiken)`,
  )
  const checks = [...prepared.checks, ...audit.checks]
  const ok = printChecks(checks)
  const r = audit.rounding
  if (!r) {
    console.log(ok ? "\nAlt stemmer." : "\nNoe avviker, se ✗ over. Rett det i Fiken.")
    if (!ok) process.exitCode = 1
    return
  }

  console.log("\nØreavrunding")
  console.log(
    "  Måneden er ført med netto fra Checkin og mva regnet av Fiken. Checkin regner mva per billett,",
  )
  console.log(
    "  så summen inkl. mva avviker med noen øre. En fri postering retter Checkin-kontoen:",
  )
  console.log(
    `  ${r.date}  ${formatNok(Math.abs(r.amount))}  debet ${r.debitAccount}, kredit ${r.creditAccount}`,
  )
  console.log(`  «${r.description}»`)
  if (mode === "dry-run") {
    console.log("\nDry run: ingenting er skrevet til Fiken. Bruk --mode create for å føre den.")
    process.exitCode = 1
    return
  }

  // The rounding itself is one of the failed checks; anything else failing needs a "ja".
  const othersOk = checks.every((c) => c.ok || isRoundingCheck(c))
  const what = `${mode === "draft" ? "Lag åpen fri postering for" : "Bokfør"} øreavrundingen i Fiken`
  if (!(await confirm(what, othersOk))) {
    console.log("Avbrutt, ingenting er skrevet til Fiken.")
    process.exitCode = 1
    return
  }
  console.log("")
  const result = await bookRounding(client, config, prepared, audit, mode, step)
  if (result.balance) {
    const { actual, expected } = result.balance
    if (actual === expected)
      step(`Saldo ${config.checkinAccount} per ${r.date}: ${formatNok(actual)}`)
    else
      warn(
        `Saldo ${config.checkinAccount} per ${r.date} er ${formatNok(actual)}, forventet ${formatNok(expected)}. Sjekk føringen i Fiken.`,
      )
  }
  console.log(othersOk ? "\nFerdig." : "\nFerdig. Andre avvik står igjen, se ✗ over.")
  if (!othersOk) process.exitCode = 1
}

/** Reads the hotel invoice from a local PDF, an inbox document, or the hotel's EHF in Fiken. */
async function readHotelSource(
  client: Fiken | undefined,
  hotel: HotelConfig,
): Promise<HotelSource> {
  const file = args[0]
  if (file) {
    const data = await readFile(file).catch(() => fail(`File ${file} not found`))
    return { invoice: await parseHotelInvoicePdf(new Uint8Array(data)), description: file }
  }
  if (!client)
    fail("Give a PDF file, or log in with `pnpm foring login` to read the EHF from Fiken")
  if (opts["inbox-doc"]) {
    const doc = await findInboxDocument(client, "")
    const invoice = await parseHotelInvoicePdf(await client.downloadInboxDocument(doc))
    return { invoice, doc, description: `Fiken-innboks ${doc.documentId} "${doc.name}"` }
  }
  const docs = await listHotelInvoices(client, hotel)
  const candidates = opts.ehf
    ? docs.filter((d) => d.ehfDocumentId === opts.ehf)
    : docs.filter((d) => d.status === "unprocessed")
  const ehf = candidates[0]
  if (!ehf || candidates.length > 1) {
    const list = docs
      .map(
        (d) =>
          `  ${d.ehfDocumentId}  ${d.issueDate ?? ""}  faktura ${d.invoiceNumber ?? "?"}  ${formatNok(d.gross ?? 0)}  (${d.status ?? ""})`,
      )
      .join("\n")
    fail(
      opts.ehf
        ? `EHF ${opts.ehf} from the hotel not found in Fiken:\n${list}`
        : candidates.length === 0
          ? `No unprocessed EHF from org.nr. ${hotel.supplier.organizationNumber} in Fiken. Use --ehf <id> or a PDF file.${list ? `\n${list}` : ""}`
          : `Several EHFs from the hotel, pick one with --ehf <id>:\n${list}`,
    )
  }
  const invoice = await parseHotelInvoicePdf(await client.downloadEhfDocument(ehf))
  return {
    invoice,
    ehf,
    description: `EHF ${ehf.ehfDocumentId} fra ${ehf.supplierName ?? "hotellet"}`,
  }
}

async function hotelInvoice() {
  const config = await loadConfig(opts.config)
  const hotel = config.hotel
  if (!hotel) fail(`No "hotel" recipe in ${opts.config}`)
  const client =
    opts.offline || (mode === "dry-run" && !(await hasCredentials()))
      ? undefined
      : await fiken(config)

  const source = await readHotelSource(client, hotel)
  const choices: HotelChoices = {
    moves: opts.move ? parseMovesArg(opts.move) : {},
    accounts: opts.account ? parseAccountsArg(opts.account) : {},
  }
  const prepared = prepareHotel(source, hotel, choices)
  const { invoice } = source
  const { plan } = prepared

  console.log(`Hotellfaktura ${invoice.number} → Fiken (${mode})`)
  console.log(`Kilde: ${source.description}`)
  console.log(
    `${invoice.supplierName ?? "Ukjent leverandør"} (org.nr. ${invoice.supplierOrgNr ?? "?"}), fakturadato ${invoice.date}, forfall ${invoice.dueDate ?? "?"}, KID ${invoice.kid ?? "–"}`,
  )
  console.log(`Fakturatotal ${formatNok(invoice.total)}, ${invoice.lines.length} linjer`)

  // Each category with the bills and lines in it, so they can be moved with --move.
  const groups = groupByBill(plan.placements)
  const ruleText = (by: (typeof plan.placements)[number]["by"]) =>
    by === "line"
      ? "flyttet"
      : by === "bill"
        ? "regning flyttet"
        : by === "none"
          ? ""
          : `regel ${by.rule + 1}`
  for (const category of [...hotel.categories.map((c) => c.id), undefined]) {
    const label = category
      ? hotel.categories.find((c) => c.id === category)?.label
      : "Uten kategori (stopper føringen)"
    const inCategory = groups
      .map((g) => ({ ...g, placements: g.placements.filter((p) => p.category === category) }))
      .filter((g) => g.placements.length > 0)
    if (inCategory.length === 0) continue
    const sum = inCategory.flatMap((g) => g.placements).reduce((s, p) => s + p.line.gross, 0)
    console.log(`\n${category ? `[${category}] ` : ""}${label}  ${formatNok(sum)}`)
    // Room bills name a guest; they are only counted.
    const rooms = inCategory.filter((g) => g.section === "Stay")
    if (rooms.length > 0) {
      const roomSum = rooms.flatMap((g) => g.placements).reduce((s, p) => s + p.line.gross, 0)
      console.log(`  Stay: ${rooms.length} regninger, ${formatNok(roomSum)}`)
    }
    for (const g of inCategory.filter((g) => g.section !== "Stay")) {
      console.log(`  ${g.bill ?? "(uten regning)"}  ${g.section}`)
      for (const p of g.placements)
        console.log(
          `    #${String(p.line.n).padEnd(4)} ${p.line.text.padEnd(40)} ${formatNok(p.line.gross).padStart(16)}  ${ruleText(p.by)}`,
        )
    }
  }

  printLines(
    `\nKjøp fra ${invoice.supplierName ?? "hotellet"}, referanse "${plan.reference}", ikke betalt`,
    plan.lines.map((l) => ({ ...l, vatType: l.deduct ? l.vatType : `${l.vatType}, uten fradrag` })),
    plan.gross,
  )

  console.log("\nKontroller mot fakturaen")
  let checksOk = printChecks(prepared.checks)

  if (!client) {
    console.log("\n(Ingen kontakt med Fiken: ikke innlogget eller --offline er satt)")
    return
  }

  const state = await inspectHotel(client, hotel, source, { attach: !opts["no-attach"] })
  console.log(
    `\nFiken: ${state.company.name} (${state.company.slug})${state.company.testCompany ? " [testselskap]" : ""}`,
  )
  if (state.supplier)
    step(
      `Leverandør: ${state.supplier.name} (${state.supplier.accountCode ?? state.supplier.contactId})`,
    )
  if (state.ehf)
    step(`Vedlegg: EHF ${state.ehf.ehfDocumentId} (faktura ${state.ehf.invoiceNumber ?? "?"})`)
  else if (state.doc) step(`Vedlegg: ${state.doc.documentId} "${state.doc.name}"`)
  const names = new Map(state.accounts.map((a) => [a.code, a.name]))
  for (const account of new Set(plan.lines.map((l) => l.account)))
    if (names.has(account)) step(`Konto ${account} ${names.get(account) ?? ""}`)
  const blockers = hotelBlockers(prepared, state)
  for (const b of blockers) warn(b)
  checksOk = checksOk && blockers.length === 0
  if (blockers.length > 0) fail("Kan ikke føre, se ✗ over.")

  if (mode === "dry-run") {
    console.log("\nDry run: ingenting er skrevet til Fiken. Bruk --mode draft eller --mode create.")
    return
  }

  const what = `${mode === "draft" ? "Lag kjøpsutkast" : "Bokfør kjøpet"} på ${formatNok(plan.gross)} i Fiken`
  if (!(await confirm(what, checksOk))) {
    console.log("Avbrutt, ingenting er skrevet til Fiken.")
    return
  }
  console.log("")
  const result = await bookHotel(client, prepared, state, mode, step)
  if (result.total) {
    const { actual, expected } = result.total
    if (actual === expected) step(`Kjøpet i Fiken: ${formatNok(actual)}`)
    else
      warn(
        `Kjøpet i Fiken er ${formatNok(actual)}, forventet ${formatNok(expected)}. Sjekk det i Fiken.`,
      )
  }
  console.log("\nFerdig. Betalingen kobles til kjøpet når den kommer på banken.")
}

async function readUtleggSource(
  client: Fiken | undefined,
  utlegg: UtleggConfig,
): Promise<UtleggSource> {
  const file = args[0]
  if (file) {
    const data = await readFile(file).catch(() => fail(`File ${file} not found`))
    return readUtleggPdf(new Uint8Array(data), { file }, file)
  }
  if (!client) fail("Give a PDF file, or log in with `pnpm foring login` to read the inbox")
  let doc: InboxDocument | undefined
  if (opts["inbox-doc"]) {
    const id = opts["inbox-doc"]
    doc = (await client.inbox({ status: "all" })).find((d) => d.documentId === id)
    if (!doc) fail(`Inbox document ${id} not found`)
  } else {
    const docs = (await listUtleggDocuments(client, utlegg)).filter((d) => !d.status)
    const list = docs
      .map((d) => `  ${d.documentId}  ${d.createdAt.slice(0, 10)}  ${d.name} (${d.filename})`)
      .join("\n")
    if (docs.length !== 1)
      fail(
        docs.length === 0
          ? `No unused inbox document matching "${[utlegg.inboxName].flat().join('" or "')}". Use --inbox-doc <id> or a PDF file (see \`pnpm foring inbox\`).`
          : `${docs.length} utleggsrapporter in the inbox, pick one with --inbox-doc <id>:\n${list}`,
      )
    doc = docs[0]!
  }
  return readUtleggPdf(
    await client.downloadInboxDocument(doc),
    { doc, publicKey: minTdcPublicKey(utlegg) },
    `Fiken-innboks ${doc.documentId} "${doc.name}"`,
  )
}

/** Min TDC's public key: REPORT_SIGNING_PUBLIC_KEY (e.g. a dev Min TDC's) wins over the recipe. */
function minTdcPublicKey(utlegg: UtleggConfig): string | undefined {
  const env = process.env.REPORT_SIGNING_PUBLIC_KEY?.trim()
  if (!env) return utlegg.minTdc?.publicKey
  const parsed = Ed25519PublicKey.safeParse(env)
  if (!parsed.success) fail(`REPORT_SIGNING_PUBLIC_KEY: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

/** Min TDC's signature, for the reviewer. Information only: it never blocks or allows booking. */
function printMinTdc(result: MinTdcResult | undefined) {
  if (!result) {
    console.log("Min TDC: ikke sjekket (lokal fil, ingen beskrivelse fra innboksen)")
    return
  }
  const s = summarizeMinTdc(result)
  const mark = { ok: "✓", neutral: "·", warning: "!", error: "✗" }[s.tone]
  console.log(`${mark} ${s.title}: ${s.detail}`)
  for (const p of s.problems) console.log(`    ✗ ${p}`)
}

async function utleggClaim() {
  const config = await loadConfig(opts.config)
  const utlegg = config.utlegg
  if (!utlegg) fail(`No "utlegg" recipe in ${opts.config}`)
  const client =
    opts.offline || (mode === "dry-run" && !(await hasCredentials()))
      ? undefined
      : await fiken(config)

  const source = await readUtleggSource(client, utlegg)
  const choices: UtleggChoices = {
    moves: opts.category ? parseRowChoicesArg(opts.category) : {},
    rates: opts.rate ? parseRatesArg(opts.rate) : {},
    accounts: opts.account ? parseAccountsArg(opts.account) : {},
  }
  const prepared = prepareUtlegg(source, utlegg, choices)
  const { report } = source
  const { plan } = prepared

  console.log(`Utleggsrapport → Fiken (${mode})`)
  console.log(`Kilde: ${source.description}`)
  if (report.reportId) console.log(`Rapport ${report.reportId} (skjemaets format ${report.format})`)
  printMinTdc(source.minTdc)
  console.log(
    `${report.name}, ${report.email ?? "uten e-post"}, ${report.bankAccount ? `konto ${report.bankAccount}` : report.iban ? `IBAN ${report.iban}` : "uten kontonummer"}, utbetaling i ${report.payoutCurrency}`,
  )
  console.log(
    `Laget ${report.generated ?? "?"}, ${report.rows.length} kvitteringer, total ${formatMoney(report.total ?? 0, plan.currency)}`,
  )

  const label = (id?: string) =>
    utlegg.categories.find((c) => c.id === id)?.label ?? "uten kategori"
  const rateBy = {
    choice: "valgt",
    receipt: "fra kvitteringen",
    currency: "utenlandsk",
    category: "etter kategori",
  }
  console.log("")
  for (const p of plan.placements) {
    const by =
      p.by === "moved"
        ? "flyttet"
        : p.by === "form"
          ? "fra skjemaet"
          : p.by === "none"
            ? ""
            : `regel ${p.by.rule + 1}`
    const rate = p.rate === undefined ? "mva ?" : `${p.rate} % ${p.rateBy ? rateBy[p.rateBy] : ""}`
    console.log(
      `  #${String(p.row.n).padEnd(3)} ${p.row.date}  ${p.row.description.slice(0, 40).padEnd(40)} ${(p.row.amount === undefined ? "—" : formatMoney(p.row.amount, plan.currency)).padStart(14)}  [${p.category ?? "?"}] ${label(p.category)}, ${rate}${by ? `, ${by}` : ""}${p.row.receiptHasText ? "" : ", bilde"}`,
    )
  }

  printLines(
    `\nKjøp fra ${report.name}, referanse "${plan.reference}", dato ${plan.date}, forfall ${plan.dueDate}, ikke betalt${plan.currency === "NOK" ? "" : `, i ${plan.currency}`}`,
    plan.lines,
    plan.gross,
    plan.currency,
  )

  console.log("\nKontroller mot rapporten")
  let checksOk = printChecks(prepared.checks)

  if (!client) {
    console.log("\n(Ingen kontakt med Fiken: ikke innlogget eller --offline er satt)")
    return
  }

  const state = await inspectUtlegg(client, source, plan, { attach: !opts["no-attach"] })
  console.log(
    `\nFiken: ${state.company.name} (${state.company.slug})${state.company.testCompany ? " [testselskap]" : ""}`,
  )
  if (state.person) step(describePerson(state.person))
  if (state.doc) step(`Vedlegg: ${state.doc.documentId} "${state.doc.name}"`)
  const names = new Map(state.accounts.map((a) => [a.code, a.name]))
  for (const account of new Set(plan.lines.map((l) => l.account)))
    if (names.has(account)) step(`Konto ${account} ${names.get(account) ?? ""}`)
  for (const n of state.notes) console.log(`  ! ${n}`)
  const blockers = utleggBlockers(prepared, state)
  for (const b of blockers) warn(b)
  checksOk = checksOk && blockers.length === 0
  if (blockers.length > 0) fail("Kan ikke føre, se ✗ over.")

  if (mode === "dry-run") {
    console.log("\nDry run: ingenting er skrevet til Fiken. Bruk --mode draft eller --mode create.")
    return
  }

  const what = `${state.person?.status === "new" ? `Legg inn ${report.name} som leverandør og ` : state.person?.update ? `Legg inn ${describeUpdate(state.person.update).toLowerCase()} på ${report.name} og ` : ""}${mode === "draft" ? "lag kjøpsutkast" : "bokfør kjøpet"} på ${formatMoney(plan.gross, plan.currency)} i Fiken`
  if (source.minTdc?.status === "failed")
    warn("Min TDC-signaturen stemmer ikke (se over). Sjekk med personen før du fører.")
  if (!(await confirm(what, checksOk))) {
    console.log("Avbrutt, ingenting er skrevet til Fiken.")
    return
  }
  console.log("")
  const result = await bookUtlegg(client, prepared, state, mode, step)
  if (result.total) {
    const { actual, expected } = result.total
    if (actual === expected) step(`Kjøpet i Fiken: ${formatMoney(actual, plan.currency)}`)
    else
      warn(
        `Kjøpet i Fiken er ${formatMoney(actual, plan.currency)}, forventet ${formatMoney(expected, plan.currency)}. Sjekk det i Fiken.`,
      )
  }
  console.log(
    "\nFerdig. Økonomiansvarlig betaler kjøpet fra Fiken; betalingen kobles i bankavstemmingen.",
  )
}

async function utleggHistory() {
  const config = await loadConfig(opts.config)
  const client = await fiken(config)
  const year = args[0] ? Number(args[0]) : new Date().getFullYear()
  if (!Number.isInteger(year) || year < 2000) fail(`Invalid year "${args[0]}"`)
  // Without a year: last year too, since the conference's utlegg straddle the turn of the year.
  const from = `${args[0] ? year : year - 1}-01-01`
  const to = `${year}-12-31`
  const items = pastUtlegg(
    await client.purchasesBetween(from, to),
    await client.journalEntriesBetween(from, to),
  )
  console.log(`Utlegg i Fiken ${from} – ${to}: ${items.length}`)
  for (const i of items) {
    const head = [
      i.date,
      i.source === "purchase" ? `kjøp ${i.id}` : `kontantutlegg ${i.id}`,
      i.who,
      i.description,
      i.kind,
      i.currency && i.currency !== "NOK" ? i.currency : undefined,
      i.paid === false ? "ikke betalt" : undefined,
      i.paidFrom.length > 0 ? `betalt fra ${i.paidFrom.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("  ·  ")
    console.log(`\n${head}`)
    for (const l of i.lines)
      console.log(
        `  ${l.account.padEnd(10)} ${l.vat.padEnd(8)} netto ${formatNok(l.net).padStart(14)}  mva ${formatNok(l.vatAmount).padStart(12)}  ${(l.description ?? "").slice(0, 50)}`,
      )
  }
  console.log("\nPer konto og mva (kostnadslinjer, i NOK)")
  for (const p of utleggPractice(items))
    console.log(
      `  ${p.account.padEnd(6)} ${p.vat.padEnd(8)} ${String(p.count).padStart(3)} stk  netto ${formatNok(p.net).padStart(14)}  mva ${formatNok(p.vatAmount).padStart(12)}`,
    )
}

async function main() {
  if (opts.help || !command || command === "help") {
    console.log(HELP)
    return
  }
  switch (command) {
    case "report":
      return report()
    case "check":
      return check()
    case "hotell":
    case "hotel":
      return hotelInvoice()
    case "utlegg":
      return utleggClaim()
    case "utlegg-history":
      return utleggHistory()
    case "login":
      return login()
    case "logout":
      return logout()
    case "companies":
      for (const c of await (await fiken()).companies()) {
        console.log(
          `${c.slug.padEnd(30)} ${c.name} (${c.organizationNumber})${c.testCompany ? " [test]" : ""}`,
        )
      }
      return
    case "accounts": {
      const config = await loadConfig(opts.config)
      for (const a of await (await fiken(config)).bankAccounts()) {
        console.log(
          `${a.accountCode.padEnd(12)} ${a.name} (${a.type})${a.inactive ? " [inaktiv]" : ""}`,
        )
      }
      return
    }
    case "chart": {
      const config = await loadConfig(opts.config)
      for (const a of await (await fiken(config)).accounts(args[0] ?? "4000-8999"))
        console.log(`${a.code.padEnd(12)} ${a.name ?? ""}`)
      return
    }
    case "contacts": {
      // Helps find the contact id / org. number of Checkin for regnskap.config.json.
      const config = await loadConfig(opts.config)
      const filter = (args[0] ?? "checkin").toLowerCase()
      for (const c of await (await fiken(config)).contacts()) {
        if (!c.name.toLowerCase().includes(filter)) continue
        const roles = [
          c.customer && `kunde ${c.customerAccountCode ?? ""}`,
          c.supplier && `leverandør ${c.supplierAccountCode ?? ""}`,
        ]
        console.log(
          `${String(c.contactId).padEnd(12)} ${c.name} (org.nr. ${c.organizationNumber ?? "–"}) ${roles.filter(Boolean).join(", ")}${c.inactive ? " [inaktiv]" : ""}`,
        )
      }
      return
    }
    case "inbox": {
      const config = await loadConfig(opts.config)
      for (const d of await (await fiken(config)).inbox({ status: "unused" })) {
        console.log(
          `${String(d.documentId).padEnd(12)} ${d.createdAt.slice(0, 10)}  ${d.name} (${d.filename})`,
        )
      }
      return
    }
    default:
      fail(`Unknown command "${command}"\n\n${HELP}`)
  }
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : err}`)
  if (mode === "create" || mode === "draft") {
    console.error(
      "Steps marked ✓ after the confirmation were completed in Fiken; finish or clean up the rest manually.",
    )
  }
  process.exit(1)
})
