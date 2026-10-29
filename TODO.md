# TODO

Open questions to verify on a Fiken test company (`testCompany: true`, with the API module enabled) before the first real month is booked with fri posteringer. Findings from the public docs follow, with sources.

## To verify

- [ ] **Bank line ↔ our fri postering (the main question).** Book a month in the test company with `--mode create`, then import or type in the bank line for one payout on 1920:10001, and open *Annet → Superføring*.
  - Does Fiken suggest "Legg til som bilag" or a link to our posting by itself?
  - Is the suggestion still there when the posting is dated 1–3 days before the bank line (Checkin "Bokført" vs bank arrival)?
  - If not, does *Alternativer → Finn eksisterende posteringslinje* find it? Check that the line then shows as "Bokført", and that *Avstem* gives a zero difference for the month.
  - Write down the exact clicks for the README.
- [ ] **Which date to use.** Fiken's guidance (see findings) is to date the bank side on the day the money *arrived in the bank*. We use Checkin's "Bokført" date.
  - Compare "Bokført" with the bank date for a few months of real payouts.
  - If they differ, decide between three options:
    1. Keep "Bokført" and link manually.
    2. Date the posting on the bank date. That date is not in the report, so it would need input or a bank lookup.
    3. Accept that a payout across the month-end puts the 1920 reconciliation off for that month.
  - The tool already accepts an existing superføring up to 10 days after "Bokført" as the same payout. The "Utbetalt til bank" check counts Fiken movement within the report month only, so such a payout booked in the next month fails that check.
- [ ] **Double booking.** Nothing in Fiken stops someone from also choosing *Registrer ny fri postering* on the bank line, which books the payout a second time.
  - Agree on a routine: our posting exists, so use *Finn eksisterende posteringslinje* or *Legg til som bilag*, never *Registrer ny fri postering*.
  - In the test company, check how the double booking shows up. Both our balance check and Fiken's bankavstemming should flag it.
  - The reverse order is handled: if the superføring is made first, the tool finds it by amount and date and skips that payout.
- [ ] **Open entries (draft mode).**
  - Do `open: true` entries show up in `GET /journalEntries`? The tool relies on this to skip them on a later `--mode create`.
  - Do they count in `accountBalances`?
  - Can they be linked in Superføring?
  - How are they closed (finalised) in the UI?
- [ ] **Custom `vat` on order lines.** We send Checkin's VAT, e.g. 3 118,29 instead of 25 % = 3 118,06.
  - Book a sale and a purchase with a `vat` that is 23 øre off 25 %.
  - Check whether Fiken keeps the amount we sent or recalculates it from `vatType`: compare `GET /sales/{id}` and the posting on 2700/2710.
  - If Fiken recalculates, the Checkin account will drift by øre every month. Then turn off `useCheckinVat`, or book the difference separately.
- [ ] **The same inbox document on several entries.** Attaching marks the document as used.
  - Check that attaching the same `inboxDocumentId` to the sale, then the purchase, then two journal entries all succeed.
  - If the second attach fails, upload the PDF as a file instead, or attach only to the sale.
- [ ] **Location header of `POST /generalJournalEntries`.**
  - Log the header, then compare its id with `journalEntryId` and `transactionId` from `GET /journalEntries`.
  - We pass the id to `POST /journalEntries/{id}/attachments`. If the header holds a transaction id, the attach fails or hits the wrong entry.
  - Also check whether the description in GET has the "Fri postering registrert via API: " prefix. Voucher matching uses a substring, so it works either way.
- [ ] **Supplier purchase paid immediately.**
  - Check that `kind: "supplier"` with `paid: true`, `paymentAccount` and `paymentDate` in one `POST /purchases` gives a purchase that is settled at once (supplier ledger 2400:xxxxx back to 0), not an open payable.
  - Same check for the sale with `customerId` (1500:xxxxx).
- [ ] **The real Checkin account code.** `1960:10001` in `regnskap.config.json` is a guess. Run `pnpm foring accounts` against the real company and correct `checkinAccount` and `bankAccount`.
- [ ] **Øreavrunding on old months (incl. the June 1-øre error).** `check` now offers a fri postering against `reconcile.roundingAccount` (default 7740) for months booked with Fiken's VAT, see docs/foring.md "Rette eldre måneder".
  - Confirm 7740 with the accountant.
  - Try it in the test company first. Check that journal entry lines come back with the account codes we post (`1960:10001`, `7740`); a rounded month is only detected that way.
  - Run `check` on each old month, then check that "Saldo" is exact for the latest one. Before the corrections it is a few øre off; it allows up to 1 kr.

- [ ] **Hotel invoice: lines without deduction.** We book them as the gross with `vatType: "NONE"` on 5990, 7350 and 7140 (frokost). The API has no domestic "uten fradrag" VAT type for purchases (only `*_FOREIGN_SERVICE_NONDEDUCTIBLE` and gold/emission quotas).
  - Book the 2026 invoice as a draft in the test company and check that Fiken accepts NONE on those accounts, and that the lines don't show in the mva-melding.
  - Confirm with the accountant that this is how they want non-deductible VAT (gross on the cost account), and the categories: bar/fest 25 % with deduction, crew and speakers' dinner without, rooms 12 % with and breakfast without.
- [ ] **Hotel invoice: accounts.** 6300, 4500, 5990, 7350, 7140 and 7770 are suggestions, not read from the company's chart. Run `pnpm foring chart` and adjust `hotel.categories[].account` (the review blocks if an account is missing).
- [ ] **Hotel invoice: EHF.** The tool reads the hotel's EHF via `GET /ehf` and attaches it with `ehfDocumentId`.
  - Check that `documentUrl` gives the hotel's own PDF (with text layer and the same layout), not a page Fiken renders from the XML. If not, read it from the inbox with `--inbox-doc` or a local file.
  - Check that attaching the EHF to a purchase (and to a purchase draft) works, and that the EHF leaves the inbox.
  - Check that an EHF Fiken has booked itself gets `status: "processed"` and `purchaseId`; the tool then refuses to book it again.
- [ ] **Hotel invoice: unpaid supplier purchase.** `kind: "supplier"`, `paid: false`, `dueDate`, `kid` in one `POST /purchases`.
  - Check that it stays open on the hotel's 2400:xxxxx with the due date and KID, and that the bank payment can be matched to it in Superføring.
  - Check that `attachToPayment: false` is accepted for an unpaid purchase.
- [ ] **Hotel invoice: 25 % lines with deduction rounding.** Fiken derives net and VAT from the gross per line. On the 2026 invoice our VAT per rate matches the VAT specification to the øre; the check allows 1 kr.

## Findings (public docs, October 2026)

hjelp.fiken.no renders with JavaScript. The articles can be read at `https://hjelp.fiken.no/<slug>`.

- **Superføring is the bank-line screen** (*Annet → Superføring*), where bank movements are booked and linked before reconciling. Fiken suggests an action per line from the bank data and the existing books:
  - If a line is already booked, it typically suggests *Legg til som bilag*. This changes nothing in the books and marks the line "Bokført".
  - Under *Alternativ*: *Ignorer linje*, *Finn eksisterende posteringslinje*, and linking the line to an entry already in the books.
  - Source: https://hjelp.fiken.no/slik-bruker-du-superfoering
- **Matching needs a correct date and amount.** "Om alle betalinger er ført riktig, vil Fiken i superføring foreslå å kun knytte banklinjen til transaksjonen. Dersom Fiken ikke klarer dette, kan det være at betalingen er ført på feil dato, med feil betalingsmåte, eller med feil beløp."
  - No date tolerance is documented. All examples use the same date and amount.
  - Sources: https://hjelp.fiken.no/slik-bruker-du-superfoering, https://hjelp.fiken.no/hva-er-superfoering, https://hjelp.fiken.no/fiken-folio
- **Linking is not needed for the balance.** Removing a link "påvirker ikke regnskapet ditt". Reconciliation compares balances: *Avstem* when the difference is 0, otherwise *Finn forskjellen med bankavstemming*. Reconciled periods are locked.
  - Sources: https://hjelp.fiken.no/slik-bruker-du-superfoering, https://hjelp.fiken.no/hva-er-og-hvordan-fungerer-bankavstemming, https://hjelp.fiken.no/bankavstemming-med-superfoering
- **Date of payment-service payouts:** book them "med samme dato du har fått pengene overført". Fiken support describes a transfer booked 30.04 that arrived 01.05 as breaking that month's reconciliation; the fix is to annul it and re-date it.
  - Source: https://hjelp.fiken.no/overfoering-fra-betalingstjenester-klarna-nets-vipps-osv
- **Our current manual routine is Fiken's documented one** for payment services: bank line → *Alternativer* → *Registrer ny fri postering*, debit the bank, credit the clearing account.
  - Payment-service accounts (1960:xxxxx) are clearing accounts. They are not bank-reconciled but should return to about 0.
  - Sources: https://hjelp.fiken.no/fiken-og-integrasjon-med-aspitphysicapsykbase, https://hjelp.fiken.no/hvordan-opprette-bankkonto-i-fiken
- **Double booking.** "Hvis du allerede har ført kjøp, salg og betalinger for en periode skal ikke disse føres på ny i superføring." Bankavstemming flags double payments.
  - Sources: https://hjelp.fiken.no/slik-bruker-du-superfoering, https://hjelp.fiken.no/bankavstemming-med-superfoering
- **The API has no bank lines and no reconciliation.** API v2 only has `bankAccounts` (with read-only `reconciledBalance` / `reconciledDate`) and `bankBalances`. "Avstemming" appears only as a `transactionType`. So the tool cannot link or reconcile the bank line; that stays manual.
  - Source: https://api.fiken.no/api/v2/docs/swagger.yaml
- **API details (swagger):**
  - `open: true` on `generalJournalEntries`: "these can be deleted without creating a counter transaction".
  - Fiken prefixes the description with "Fri postering registrert via API: ", which counts toward the 200-character limit.
  - `orderLine.vat` exists ("VAT amount of order line in cents"), but nothing says whether it overrides `vatType`.
  - Attachment endpoints say the inbox document "is marked as used". Nothing says whether it can be attached again.

## Smaller things

- [ ] Web UI: the heading "Utbetalinger (skal være superført)" in `src/components/review-screen.tsx` is outdated. The tool now books them.
