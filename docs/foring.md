# Føring

Slik føres en måned fra Checkin i Fiken. Oppsett og kjøring står i [README](../README.md).

Fører Checkin-regnskapsbilaget i Fiken. Per måned blir det:

- ett *Annet salg* (billettinntekter),
- ett *kjøp* (Checkin-gebyrer),
- én *fri postering* per utbetaling fra Checkin til banken.

Bilaget legges ved alle føringene. Før noe føres, kontrolleres alle tallene mot rapporten selv og mot Checkin-kontoen i Fiken.

- **Web-app:** https://regnskap.trondheimdc.no fungerer på mobil. Logg inn med Fiken og velg bilaget fra innboksen. Gjennomgangen viser tallene og kontrollene, og hvert tall er markert i PDF-en. Avslutt med «Lag utkast» eller «Bokfør».
- **CLI:** `pnpm foring report` gjør det samme fra terminalen.

Begge bruker den samme koden i `src/lib` (PDF-leser, oppskrift, kontroller, Fiken-klient).

## Arkitektur

- **Statisk SPA:** Next.js `output: "export"`, servert av nginx. Ingen app-server, database eller hemmeligheter på serveren.
- **Innlogging:** OAuth med PKCE direkte mot Fiken. Tokenet ligger bare i nettleserfanen (sessionStorage). Hvem som har tilgang styres i Fiken: godkjente brukere på Fiken-appen og tilgang til selskapet.
- **Fiken-API:** api.fiken.no støtter ikke CORS, så nginx videresender `/api/fiken/*` til API-et. Proxyen har ingen nøkler. Hver forespørsel bruker den innloggede brukerens eget token.
- **Oppskriften:** ligger i `regnskap.config.json` og bygges inn i appen. En endring krever commit og deploy.

Se [docs/deploy.md](docs/deploy.md) for oppsett av Fiken-app, GitHub, nginx og DNS.

## Utvikling

```sh
mise install                       # Node + pnpm
cp .env.example .env.local         # NEXT_PUBLIC_FIKEN_CLIENT_ID=...
pnpm install
pnpm dev                        # http://localhost:3000
mise run check                     # lint, typecheck, test
```

Testene i `test/` bruker en generert PDF (`test/pdf-fixture.ts`) og en falsk Fiken-klient (`test/booking.test.ts`). Ekte bilag skal ikke sjekkes inn.

Verktøyet er skrevet i TypeScript og bruker [zod](https://zod.dev) til validering og [unpdf](https://github.com/unjs/unpdf) (pdf.js) til å lese PDF-en. PDF-en leses i nettleseren.

### CLI

```sh
pnpm foring login                   # OAuth i nettleseren (samme Fiken-app, redirect http://127.0.0.1:8723/callback)
pnpm foring report                  # dry-run: henter bilaget fra innboksen og kontrollerer
pnpm foring report --mode create    # fører, etter bekreftelse
```

Tokenet lagres i `~/.config/trondheimdc-regnskap/oauth-token.json` (kun lesbart for deg) og fornyes automatisk. Hvis `FIKEN_API_TOKEN` (personlig API-nøkkel) er satt, brukes den i stedet.

## Flyten

Checkin sender regnskapsbilaget som PDF til Fiken-innboksen. Verktøyet henter PDF-en derfra, leser tallene og fører dem. Det går gjennom de samme stegene hver gang:

1. **Leser** netto endring per Checkin-konto fra sammendragssiden (side 2) i PDF-en og viser hvilken linje i oppskriften hvert beløp havner på.
2. **Kontrollerer** tallene mot resten av rapporten:
   - Beregnet mva mot Checkins mva-kontoer (2701/2711).
   - Utbetalingsoversikten mot 1920.
   - Salg minus kjøp mot netto endring på 1500 + 1920 + 1921.

   Verktøyet fører ikke på mva-kontoene selv. Fiken fører mva ut fra mva-typen på linjen, som i den manuelle oppskriften. 2701/2711 er Checkins kontoer i PDF-en.

   Checkin runder mva per billett og gebyr, og kan derfor avvike noen øre fra 25 % av totalen. Fiken godtar ikke et eget mva-beløp: netto må være brutto / 1,25. For at Checkin-kontoen i Fiken skal stemme på øret, sendes bruttobeløpet Checkin faktisk har belastet (netto + Checkins mva), og netto regnes ut fra det. Øreavrundingen havner da mellom netto og mva, så lenge avviket er under 1 kr. Dette kan slås av med `"reconcile": { "useCheckinVat": false }`.

   Mva-kontrollen feiler hvis avrundingen havner i Skatteetatens disfavør: mindre utgående mva enn billettene viser, eller mer inngående mva enn Checkin fakturerte. Det er noen øre; vurder om du vil føre likevel.
3. **Sjekker mot Fiken:**
   - at bankkontoene finnes,
   - at vedlegget finnes,
   - om salg, kjøp eller utkast for måneden allerede er ført,
   - hvilke utbetalinger som allerede er flyttet til banken i Fiken (se [Utbetalinger](#utbetalinger-fri-posteringer)).

   Deretter **avstemmes Checkin-kontoen** i Fiken (`checkinAccount`, f.eks. 1960:10001) mot rapporten, se under.
4. **Spør** før noe skrives. I web-appen bekrefter du i en dialog. Hvis noen kontroller feilet, må du først krysse av for at du har sett avvikene. I CLI-en svarer du `j`, eller `ja` hvis noe feilet.
5. **Fører** salget og kjøpet, og én fri postering per utbetaling som ikke allerede finnes. PDF-en legges ved alt, og linjene periodiseres hvis det er konfigurert.

Det finnes tre moduser. I web-appen er dry-run selve gjennomgangen, og knappene er «Lag utkast» og «Bokfør».

- **`--mode dry-run`** (standard): stopper etter steg 3 og skriver ingenting.
- **`--mode draft`**: lager salgs- og kjøpsutkast i Fiken med vedlegg.
  - Fiken har ingen utkast for fri postering. Utbetalingene føres derfor som *åpne* fri posteringer, som kan slettes uten motpostering.
  - Hvis periodisering er konfigurert, må den gjøres manuelt når utkastet bokføres, fordi utkast ikke kan periodiseres via API-et.
- **`--mode create`**: fører alt ferdig.

CLI:

```sh
pnpm foring report                              # henter "Regnskapsbilag …" fra Fiken-innboksen
pnpm foring report --month 2026-03              # velg måned hvis flere bilag ligger i innboksen
pnpm foring report --inbox-doc 12345            # eller velg dokumentet direkte (se `pnpm foring inbox`)
pnpm foring report --mode create

pnpm foring report regnskapsbilag-mars-2026.pdf # lokal PDF
pnpm foring report --month 2026-03 --amounts "3000=49380,4300=1234.40,4335=1512.38"  # nødløsning
```

Med `--amounts` finnes ingen utbetalingsoversikt, så da føres ingen fri posteringer.

`--yes` hopper over spørsmålet i steg 4, men bare hvis alle kontroller er ok.

Salget og kjøpet får referansen `Checkin YYYY-MM`. Verktøyet nekter å føre samme måned to ganger.

## Kontrollere en ført måned

Et bilag som allerede er ført kan åpnes igjen, også når salget eller kjøpet er ført for hånd. Da vises en kontroll i stedet for knappene for å føre, og ingenting skrives til Fiken.

Kontrollen finner månedens salg og kjøp i Fiken. Det er dem med referansen `Checkin YYYY-MM`, og alt som er datert i måneden og betalt til eller fra Checkin-kontoen, så også måneder som er ført for hånd kommer med. Deretter sjekkes:

- **Linjene:** netto og mva per konto og mva-type i Fiken mot bilaget. Mangler, dobbeltføringer og feil konto eller mva gir avvik. Mva kan avvike med inntil 1 kr på grunn av avrunding.
- **Utbetalingene:** hver utbetaling i bilaget skal være flyttet til banken, på samme måte som under [Utbetalinger](#utbetalinger-fri-posteringer).
- **Checkin-kontoen:** det som er flyttet ut i måneden, utenom salget og kjøpet, mot det Checkin har utbetalt, og saldoen ved månedsslutt mot det Checkin holder for oss. Et saldoavvik kan stamme fra en tidligere måned.

```sh
pnpm foring check --month 2026-03     # bilaget hentes fra innboksen, også førte
pnpm foring check bilag-mars.pdf      # eller fra en lokal PDF
```

`check` avslutter med feilkode 1 hvis noe avviker.

## Utbetalinger (fri posteringer)

Hver rad i *Utbetalingsoversikt* i bilaget blir én fri postering:

| | |
|---|---|
| Debet | `bankAccount` (1920:10001) |
| Kredit | `checkinAccount` (1960:10001) |
| Dato | Checkins «Bokført»-dato for utbetalingen |
| Tekst | `MM.YYYY Innbetaling fra Checkin (bilag 17342:13)` |

Fiken legger selv til «Fri postering registrert via API: » foran teksten.

**Allerede ført.** En utbetaling hoppes over hvis den allerede er flyttet til banken i Fiken. Det gjelder i to tilfeller:

- en postering har bilagsnummeret i teksten, fordi den er ført av verktøyet før;
- en postering på Checkin-kontoen har samme beløp og er datert fra 3 dager før til 10 dager etter «Bokført»-datoen, f.eks. en superføring fra banklinjen.

Hver postering brukes bare én gang, så to like utbetalinger kobles ikke til samme postering. Annullerte posteringer telles ikke.

**Bankavstemming.** Utbetalingene skal ikke lenger superføres for hånd. Banklinjen på 1920 må fortsatt avstemmes i Fiken, men kobles nå til posteringen som allerede finnes:

- Velg *Legg til som bilag* hvis Fiken foreslår det.
- Ellers velg *Alternativer → Finn eksisterende posteringslinje*.
- Ikke velg *Registrer ny fri postering*. Da blir utbetalingen ført to ganger.

Fiken-API-et har ikke tilgang til banklinjer, så koblingen kan ikke gjøres av verktøyet. Om Fiken foreslår koblingen selv når datoene avviker med noen dager, er ikke avklart. Se [TODO.md](TODO.md).

## Oppskriften

`sale` og `purchase` i konfigurasjonen er den manuelle oppskriften:

| Fiken | Konto | Mva | Beløp fra Checkin-konto |
|---|---|---|---|
| Salg "TDC 2026" | 3000 | 25 % | 3000 |
| Kjøp "Checkin gebyr" | 4300 | 25 % | 4300 |
| Kjøp "Transaksjonsgebyr" | 4300 | ingen | 4335 |

Alle linjer føres på vår egen konto (`sale.account` / `purchase.account`), uansett hvilken konto Checkin har brukt.

Checkin-kontonumrene i `from` brukes bare til å finne riktig beløp i rapporten. Flere Checkin-kontoer kan slås sammen på én linje, f.eks. `"from": ["4300", "4302", "4303"]`.

Kontoer i rapporten som ikke er dekket av oppskriften stopper kjøringen. De må enten legges til i en `from` eller i `ignore`.

### Checkin som kunde og leverandør (reskontro)

Hvis Checkin er satt som kunde på salget og leverandør på kjøpet, havner føringene i Checkins reskontro i Fiken: kundereskontro 1500:XXXXX og leverandørreskontro 2400:XXXXX. Kontakten angis med kontakt-ID eller org.nr.:

```json
"sale":     { "account": "3000", "customer": { "organizationNumber": "994035053" }, "lines": [ … ] },
"purchase": { "account": "4300", "supplier": { "contactId": 1234567 },            "lines": [ … ] }
```

- **Salg:** med kunde føres det fortsatt som *Annet salg*, betalt til Checkin-kontoen, men knyttet til kunden.
- **Kjøp:** med leverandør blir det et leverandørkjøp (`kind: "supplier"`), betalt med en gang fra Checkin-kontoen.
- **Finne riktig kontakt:** `pnpm foring contacts checkin` viser kontakt-ID, org.nr. og reskontrokontoer. Checkin AS har org.nr. 994 035 053. Noen gebyrer kommer fra CheckinPay AS (se side 3 i bilaget).
- **Kontroll:** verktøyet sjekker at kontakten finnes og har riktig rolle, og stopper hvis ikke.

## Avstemming av Checkin-kontoen

Kontoen "Utenlandsk bankkonto / betalingstjeneste Checkin" i Fiken speiler pengene Checkin holder for oss:

- Salget fører inn på kontoen.
- Kjøpet (gebyrene) trekker fra kontoen.
- Hver utbetaling flyttes ut av kontoen med en fri postering til bankkontoen.

Før noe føres, henter verktøyet saldoen på kontoen fra Fiken ved slutten av forrige måned og ved slutten av rapportmåneden. Kontrollene regner med det kjøringen selv vil føre, altså de fri posteringene som ikke finnes fra før. Saldoen sammenlignes med rapporten på to måter:

1. **Utbetalinger.** Det som flyttes ut av kontoen i løpet av måneden skal være nøyaktig lik det Checkin sier er utbetalt til banken. Det som flyttes ut er det som allerede er ført i Fiken pluss de nye fri posteringene. Det Checkin har utbetalt er nettobevegelsen på `reconcile.payoutAccounts` (1920 «Bankinnskudd»).
   Et avvik betyr som regel at noe annet er ført på Checkin-kontoen. Det kan også bety at en utbetaling allerede er ført med feil beløp, eller datert i neste måned.
2. **Saldo (valgfritt).** Hvis `reconcile.balanceAccounts` er satt, sammenlignes saldoen på kontoen etter føring med utgående saldo på de kontoene i Checkin-rapporten, altså det Checkin holder for oss. Saldoen etter føring er saldoen i Fiken pluss salget, minus kjøpet og de nye utbetalingene.

Etter `--mode create` hentes saldoen på nytt for å bekrefte at Fiken har ført det som var planlagt.

```json
"reconcile": { "payoutAccounts": ["1920"], "balanceAccounts": ["1500", "1921"], "outputVat": { "HIGH": "2701" }, "inputVat": { "HIGH": "2711" } }
```

I Checkins regnskapsbilag er 1500 kundefordringer (fakturerte billetter som ikke er betalt ennå) og 1921 penger Checkin/CheckinPay holder for oss. 3990 er Checkins egen periodisering, som vi ikke følger, og står derfor i `ignore`.

## Begrensninger

- **PDF-leseren:** Den er testet mot et ekte regnskapsbilag (september 2026). Den finner sammendragssiden med *Resultat*, rader som starter med `<konto> - <navn>` og beløpet under *Netto endring*. Hvis Checkin endrer oppsettet, vil kontrollene i steg 2 feile.
- **Banklinjer:** Fiken-API-et har ingen banklinjer eller avstemming. Den fri posteringen må derfor kobles til banklinjen i Superføring for hånd, se [Utbetalinger](#utbetalinger-fri-posteringer).
- **Dato:** Fiken anbefaler å datere overføringer fra betalingstjenester med datoen pengene kom inn på banken. Verktøyet bruker Checkins «Bokført»-dato. Hvis en utbetaling krysser et månedsskifte, kan månedens bankavstemming på 1920 avvike. Se [TODO.md](TODO.md).
- **Ikke verifisert mot Fiken:** flere ting er bare testet mot en mock av API-et og må sjekkes i et testselskap, se [TODO.md](TODO.md):
  - at samme innboksdokument kan legges ved flere føringer,
  - hvilken id `Location`-headeren for fri posteringer gir.

## Periodisering

Periodisering er valgfritt og står av i eksempelkonfigurasjonen. For å slå det på, legg til `accrual` på `sale` og/eller `purchase`:

```json
"sale": { "account": "3000", "accrual": { "account": "2965", "startDate": "2026-10-01", "periods": 1 } }
```
