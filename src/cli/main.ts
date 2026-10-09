#!/usr/bin/env -S npx tsx
// Books the monthly Checkin accounting report in Fiken: sale, purchase and a fri postering per payout.
// Run `pnpm foring help` for usage.

import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import {
  auditBooked,
  book,
  findReportDocument,
  inspectFiken,
  listReportDocuments,
  type MappingRow,
  prepare,
  type ReportSource,
  resolveCompany,
} from "../lib/booking.ts"
import { parseAmountsArg, parseReportPdf } from "../lib/checkin.ts"
import { type Config, Month, parseConfig } from "../lib/config.ts"
import { Fiken, type InboxDocument } from "../lib/fiken.ts"
import { formatMonthNo, formatNok } from "../lib/plan.ts"
import type { Check } from "../lib/verify.ts"
import { createAuth, hasCredentials, login, logout } from "./auth.ts"

const HELP = `Usage: pnpm foring <command> [options]

Commands:
  report [file.pdf]   Book a monthly Checkin regnskapsbilag as a sale, a purchase and
                      a fri postering (Checkin account -> bank) per payout.
                      Without a file the PDF is fetched from the Fiken inbox.
  check [file.pdf]    Check a month that is already booked against its regnskapsbilag:
                      sale, purchase and payouts in Fiken. Never writes.
                      Without a file, give --month or --inbox-doc (used documents too).
  companies           List Fiken companies the token can access
  accounts            List bank accounts in Fiken (to find account codes)
  inbox               List unused documents in the Fiken inbox
  contacts [name]     List Fiken contacts matching a name (default "checkin")

Options:
  --mode <m>          dry-run (default), draft or create
  --yes               Skip the confirmation prompt (only if all checks pass)
  --month <YYYY-MM>   Report month (report: read from the PDF if not given)
  --amounts <list>    report: net amounts per Checkin account instead of the PDF,
                      e.g. "3000=427521.63,4300=5163.44,4335=24711.53"
  --inbox-doc <id>    Fiken inbox document to read/attach (default: auto-detect)
  --no-attach         Do not attach any inbox document
  --offline           dry-run: skip all calls to Fiken (needs a file or --amounts)
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
    month: { type: "string" },
    amounts: { type: "string" },
    "inbox-doc": { type: "string" },
    "no-attach": { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    config: { type: "string", default: "regnskap.config.json" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const Options = z.object({
  mode: z.enum(["dry-run", "draft", "create"]),
  yes: z.boolean(),
  month: Month.optional(),
  amounts: z.string().optional(),
  "inbox-doc": z.coerce.number().int().positive().optional(),
  "no-attach": z.boolean(),
  offline: z.boolean(),
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
) {
  console.log(`\n${title}`)
  for (const l of lines) {
    console.log(
      `  ${l.account}  ${(l.description ?? "").padEnd(24)} netto ${formatNok(l.netPrice).padStart(16)}  ` +
        `mva ${formatNok(l.vat ?? 0).padStart(14)}  (${l.vatType})`,
    )
  }
  console.log(`  ${"Sum inkl. mva".padEnd(30)} ${formatNok(gross).padStart(16)}`)
}

function printAccrual(accrual: Config["sale"]["accrual"]) {
  if (accrual) {
    console.log(
      `  Periodiseres mot ${accrual.account}, start ${accrual.startDate}, ${accrual.periods} måned(er)`,
    )
  }
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
    const text = `${c.label}: ${c.source ?? "beregnet"} ${formatNok(c.expected)}, Checkin ${formatNok(c.actual)}`
    if (c.ok) {
      step(text)
    } else {
      warn(`${text} (avvik ${formatNok(c.expected - c.actual)})`)
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
  const { slug } = await resolveCompany(new Fiken(auth, "", baseUrl), config.companySlug)
  return new Fiken(auth, slug, baseUrl)
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
  for (const a of prepared.adjusted) console.log(`  Øreavrunding: ${a}`)
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
  const state = await inspectFiken(client, config, prepared, { mode, attach: !opts["no-attach"] })
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
  if (state.blockers.length === 0)
    step(`Bankkontoene finnes, og ${formatMonthNo(month)} er ikke ført ennå`)

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
  if (mode === "dry-run") {
    console.log("\nDry run: ingenting er skrevet til Fiken. Bruk --mode draft eller --mode create.")
    return
  }

  // 4–5. Confirm, then write.
  const what =
    mode === "draft"
      ? "Lag utkast (og åpne fri posteringer) i Fiken"
      : "Bokfør salg, kjøp og fri posteringer i Fiken"
  if (!(await confirm(what, checksOk))) {
    console.log("Avbrutt, ingenting er skrevet til Fiken.")
    return
  }

  console.log("")
  const result = await book(client, config, prepared, state, mode, step)
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

  console.log(
    `\nKontroller (${config.checkinAccount}: ${formatNok(audit.checkin.start)} → ${formatNok(audit.checkin.end)} i Fiken)`,
  )
  const ok = printChecks([...prepared.checks, ...audit.checks])
  console.log(ok ? "\nAlt stemmer." : "\nNoe avviker, se ✗ over. Rett det i Fiken.")
  if (!ok) process.exitCode = 1
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
