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

   Netto og mva på en linje kan avvike noen øre fra bilaget, mens summen inkl. mva er lik. Se [Øreavrunding](#øreavrunding).
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

### Føre deler av måneden

Salg, kjøp og utbetalinger kan føres hver for seg. I web-appen fjerner du haken under «Dette føres» for det du vil føre senere. I CLI-en bruker du `--only`:

```sh
pnpm foring report --mode create --only salg,kjop      # utbetalingene føres senere
pnpm foring report --mode create --only utbetalinger
```

Det som allerede ligger i Fiken, bokført eller som utkast, hoppes over og kan ikke velges. Slik retter du et feil bilag: annuller det i Fiken, åpne bilaget igjen og før bare det som mangler. Kontrollene regner med hele måneden, også det som føres senere.

## Kontrollere en ført måned

Et bilag der alt allerede er ført kan åpnes igjen, også når salget eller kjøpet er ført for hånd. Da vises en kontroll i stedet for knappene for å føre, og ingenting skrives til Fiken. Mangler noe, vises gjennomgangen med bare det som mangler valgt.

Kontrollen finner månedens salg og kjøp i Fiken. Det er dem med referansen `Checkin YYYY-MM`, og alt som er datert i måneden og betalt til eller fra Checkin-kontoen, så også måneder som er ført for hånd kommer med. Deretter sjekkes:

- **Linjene:** netto og mva per konto og mva-type i Fiken mot bilaget. Mangler, dobbeltføringer og feil konto eller mva gir avvik. Mva kan avvike med inntil 1 kr på grunn av avrunding.
- **Utbetalingene:** hver utbetaling i bilaget skal være flyttet til banken, på samme måte som under [Utbetalinger](#utbetalinger-fri-posteringer).
- **Checkin-kontoen:** det som er flyttet ut i måneden, utenom salget og kjøpet, mot det Checkin har utbetalt, og saldoen ved månedsslutt mot det Checkin holder for oss. Et saldoavvik kan stamme fra en tidligere måned.

```sh
pnpm foring check --month 2026-03     # bilaget hentes fra innboksen, også førte
pnpm foring check bilag-mars.pdf      # eller fra en lokal PDF
```

`check` avslutter med feilkode 1 hvis noe avviker.

En måned som er ført med mva regnet av Fiken, er noen øre feil. Den kan rettes herfra, se [Rette eldre måneder](#rette-eldre-måneder).

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

## Checkins rapporter og kontoplan

Kilde: [Regnskap i Checkin fra A til Å](https://www.checkinevent.com/helpcenter/regnskap-i-checkin-101-0).

### Rapportene

Checkin sender to rapporter. Bare regnskapsbilaget skal føres.

- **Oppgjørsrapport:** kvittering for hvert oppgjør, som utbetales hver 14. dag. Den viser hva oppgjøret består av, et sammendrag per arrangement og en transaksjonsliste omtrent som et kontoutdrag. Den føres ikke, men kan brukes til å kontrollere en utbetaling.
- **Regnskapsbilag:** alle bevegelser i måneden.
  - **Side 2:** balanse (IB, netto endring, UB), resultat og utbetalingsoversikt. Verktøyet leser denne siden.
  - **Side 3:** «Regnskapstall for motregning», som Checkin anbefaler å føre. Den viser de samme beløpene fordelt på mva, avdeling, prosjekt og leverandør, f.eks. Checkin AS og CheckinPay AS. Vi trenger ikke den fordelingen så lenge bare ett arrangement selger billetter om gangen, se [Begrensninger](#begrensninger).
  - **Excel-filen:** har alle posteringene.

### Kontoplanen

Kontonumrene i bilaget er Checkins standard kontoplan. Vi bruker dem bare for å finne beløpene. I Fiken føres de på våre egne kontoer, fordi Fiken fungerer annerledes:

- **Mva:** Fiken fører mva selv ut fra mva-typen på linjen. Vi fører aldri direkte på 27xx.
- **Pengene hos Checkin:** de ligger på en betalingstjenestekonto (1960:xxxxx), ikke på en bankkonto.
- **Periodisering:** Fiken periodiserer selv.

| Checkin | Betyr | I Fiken |
|---|---|---|
| 3000 Salgsinntekt, mva-pliktig | Billetter med 25 % mva | Salg på 3000, høy sats |
| 4300 Varekostnad inkl. mva | Gebyrer til Checkin med mva | Kjøp på 4300, høy sats |
| 4335 Varekostnad uten mva | Gebyrer uten mva, f.eks. transaksjonsgebyr | Kjøp på 4300, uten mva |
| 2701 / 2711 Utgående / inngående mva, høy sats | Mva på billetter / gebyrer | Føres av Fiken. Brukes i mva-kontrollen |
| 1920 Bankinnskudd | Det som er utbetalt til banken i perioden | Fri postering 1960:10001 → 1920:10001. Brukes i utbetalingskontrollen |
| 1921 Bankinnskudd Checkin | Saldoen vår hos Checkin | `checkinAccount` (1960:10001). Brukes i saldokontrollen |
| 1500 Kundefordringer | Fakturerte billetter som ikke er betalt | Ligger på `checkinAccount`. Brukes i saldokontrollen |
| 3990 / 2965 Periodisert salgsinntekt / forskuddsbetalt inntekt | Checkins periodisering frem til arrangementet | Står i `ignore`. Se [Periodisering](#periodisering) |

Kontoer som ikke er i oppskriften stopper kjøringen (se [Oppskriften](#oppskriften)). Disse har vi ikke sett ennå, men de finnes i Checkins kontoplan:

- **3200** salg unntatt mva og **2704** utgående mva, lav sats (f.eks. mat): trenger en egen salgslinje med riktig mva-type.
- **2900** gjeld til kunde (deltaker har betalt for mye): trenger egen vurdering.
- **1922** direktebetaling: betalt direkte til oss, ikke via Checkin. Pengene har aldri vært hos Checkin.
- **7745** øreavrunding (under 50 øre per bestilling), **7770** internasjonalt overføringsgebyr, **7800 / 7835** tap på fordringer: trenger en egen linje på riktig konto i Fiken.

Spør regnskapsfører før noen av disse legges i oppskriften.

**Checkins 7745 og vår 7740** er samme slags konto: øreavrunding uten mva. Forskjellen er hvor avviket oppstår.

- **7745 hos Checkin:** en deltaker har betalt noen øre for mye eller for lite på en bestilling. Det er en ekte bevegelse i bilaget, og den endrer det Checkin holder for oss.
- **7740 hos oss** (`reconcile.roundingAccount`): retter øreavvik mellom Fikens mva og Checkins mva på eldre måneder (se [Øreavrunding](#øreavrunding)). Den finnes bare i Fiken, ikke i bilaget.

Hvis 7745 dukker opp, må det tenkes gjennom før det føres:

- **Oppskriften kan ikke føre det riktig i dag.** Alle linjer føres på `sale.account` eller `purchase.account`. Legges 7745 i en `from`, havner avrundingen på 3000 eller 4300, ikke på 7740.
- **`ignore` er feil.** Beløpet mangler da i Fiken, og saldokontrollen avviker med de ørene.
- **Det må ikke føres mellom Checkin-kontoen og 7740.** Kontrollen for eldre måneder regner alle slike posteringer i måneden som vår mva-avrunding. En ført 7745 ville da skjule, eller lage, et mva-avvik. Bruk en egen konto, eller lær kontrollen å skille dem.

Om gebyrene: transaksjonsgebyret er en prosent per billett. Systemavgiften er en prosent pluss et fast beløp per billett. Tilbakebetalingsgebyret er 10 kr inkl. mva per refusjon. Andre gebyrer er SMS, print, EHF, etikettutskrift og gratisbilletter.

## Øreavrunding

Netto og mva i Fiken kan avvike noen øre fra Checkins bilag. Summen inkl. mva er alltid den samme, og det er den som går inn og ut av Checkin-kontoen.

**Hvorfor.** Checkin regner mva på hver billett og hvert gebyr, runder hver til hele øre og summerer. Summen av mva blir da ikke nøyaktig 25 % av summen av netto. Fiken regner mva av linjen selv og godtar ikke et annet beløp: netto må være brutto / 1,25 (eller tilsvarende sats). Det finnes ingen kombinasjon som gir både Checkins netto og Checkins mva på én linje.

**Hva vi gjør.** Vi fører bruttobeløpet Checkin faktisk har belastet (Checkins netto + Checkins mva) og lar Fiken regne netto og mva av det. Eksempel:

| | Netto | Mva | Sum inkl. mva |
|---|---:|---:|---:|
| Checkin (bilaget) | 1 234,40 | 308,65 | 1 543,05 |
| Fiken | 1 234,44 | 308,61 | 1 543,05 |

Alternativet, å føre Checkins netto og la Fiken regne 25 %, gir riktig netto men feil sum, og da stemmer ikke Checkin-kontoen mot bilaget.

**Hvor det vises.**
- Gjennomgangen og CLI-en viser en kort «Øreavrunding»-linje: vår mva mot Checkins.
- I Fiken får linjen teksten `Checkin gebyr (øreavrunding, mva hos Checkin 308,65 kr)`, så bilaget selv forklarer avviket mot vedlegget.

**Grenser.** Det gjøres bare når avviket er under 1 kr og det er én linje med den mva-typen. Større avvik blir stående og fanges av kontrollene. Mva-kontrollen feiler hvis avrundingen havner i Skatteetatens disfavør: mindre utgående mva enn billettene viser, eller mer inngående mva enn Checkin fakturerte. Det er noen øre; vurder om du vil føre likevel.

Slå av med `"reconcile": { "useCheckinVat": false }`. Da føres Checkins netto med 25 % mva, og Checkin-kontoen vil avvike med noen øre.

### Rette eldre måneder

Måneder som er ført før dette, med Checkins netto og mva regnet av Fiken, har samme avvik: summen inkl. mva er noen øre feil, og Checkin-kontoen avviker like mye. Kontrollen av en ført måned finner det og foreslår en *fri postering* som retter det:

| | |
|---|---|
| Debet / kredit | `checkinAccount` (1960:10001) ↔ `reconcile.roundingAccount` (standard 7740 Øreavrunding), uten mva |
| Beløp | Salg − kjøp inkl. mva i Fiken mot det samme i bilaget, for den måneden |
| Dato | Siste dag i måneden |
| Tekst | `Øreavrunding Checkin 2026-03: ført med mva regnet av Fiken, …` med begge summene |

- **Web-app:** åpne den førte måneden. Kortet «Øreavrunding» viser posteringen. Trykk «Før øreavrunding» og bekreft.
- **CLI:** `pnpm foring check --month 2026-03` viser forslaget, og `--mode create` fører det etter bekreftelse.

Mva rettes ikke. Mva-meldingene for de terminene er sendt, og avviket er noen øre per måned. Hver måned rettes for seg, så rekkefølgen spiller ingen rolle. Når en måned er rettet, foreslås det ikke igjen, fordi kontrollen regner med alle posteringer mellom Checkin-kontoen og avrundingskontoen i måneden, også de som er ført for hånd. Forslaget gis bare når avviket er under 1 kr og både salget og kjøpet er funnet. Større avvik er en feil linje, ikke avrunding.

Er perioden låst i Fiken, avviser Fiken posteringen. Da må den føres for hånd i en åpen periode. Verktøyet finner bare øreavrundinger datert i måneden, så det vil fortsatt foreslå en for den måneden. Ikke før den på nytt.

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

I Checkins regnskapsbilag er 1500 kundefordringer (fakturerte billetter som ikke er betalt ennå) og 1921 penger Checkin/CheckinPay holder for oss. 3990 er Checkins egen periodisering, som vi ikke følger, og står derfor i `ignore`. Se [Checkins rapporter og kontoplan](#checkins-rapporter-og-kontoplan).

## Begrensninger

- **Ett arrangement om gangen:** Verktøyet leser totalene på side 2, ikke per arrangement på side 3. Alt salg i måneden føres derfor som ett salg, f.eks. «TDC 2026». Det stemmer så lenge bare ett arrangement selger billetter om gangen. Starter billettsalget for neste år før årets konferanse er holdt, blandes f.eks. 2026 og 2027 sammen i samme føring og i samme periodisering.
  For å støtte det må verktøyet lese hvert arrangement for seg fra side 3 og føre ett salg og ett kjøp per arrangement, hver med sin egen periodisering. Flere føringer er ikke noe problem når det skjer automatisk.
  Inntil da: ikke start salget for neste år så lenge det fortsatt er bevegelser på årets arrangement, som salg, refusjoner eller gebyrer.
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
