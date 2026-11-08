# TDC Regnskap

Books Checkin's monthly accounting report in Fiken: one sale (ticket revenue), one purchase (Checkin fees), and one fri postering per payout to the bank. Also books the hotel's conference invoice as one supplier purchase, split into categories. And books utleggsrapporter (expense claims) from the utlegg form as one supplier purchase from the person, a line per receipt.

It is a web app, live at https://regnskap.trondheimdc.no. Nothing is written to Fiken until the numbers have been checked and you confirm.

![Gjennomgang av et regnskapsbilag](docs/screenshot.png)

## Stack

- **Next.js** (App Router, static export) + **React** + **Tailwind**
- **TanStack Query** for Fiken data
- **Zod** for the recipe and the API responses we depend on
- **unpdf** (pdf.js) to read the bilag in the browser

Login is OAuth with PKCE in the browser. api.fiken.no has no CORS, so nginx (and `next dev`) proxies `/api/fiken`. The recipe is `regnskap.config.json`, built into the app.

## Develop

### With Mise

```bash
mise install
cp .env.example .env.local   # NEXT_PUBLIC_FIKEN_CLIENT_ID=...
mise run install
mise run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Tasks:** `mise run install` | `mise run dev` | `mise run build` | `mise run check`

### Without Mise

Install Node and pnpm.

```bash
pnpm install
pnpm dev
```

### Min TDC

Utleggsrapporter that Min TDC uploads to the Fiken inbox carry an Ed25519 signature over the PDF and the sender. The review shows "Fra Min TDC – verifisert" with the address, login and roles, and a warning when the signature doesn't hold. Reports without a signature show nothing and work as before. It needs Min TDC's public key in `utlegg.minTdc.publicKey` in `regnskap.config.json` (see [docs/foring.md](docs/foring.md#fra-min-tdc)). It is information for the reviewer and doesn't change how a report is booked. `pnpm dev:mock` has a verified report (Ola Testesen) and one with a borrowed signature (Per Testesen).

### Tests

`mise run check` runs Biome, tsc and Vitest. Tests use a generated PDF (`test/pdf-fixture.ts`). Do not commit a real regnskapsbilag.

## Further reading

| Doc | Contents |
|---|---|
| [docs/foring.md](docs/foring.md) | How a month is booked, the checks, the fri posteringer, the hotel invoice, and utlegg |
| [docs/deploy.md](docs/deploy.md) | Fiken app, nginx, DNS, and the deploy: live at regnskap.trondheimdc.no, every push to `main` deploys |
| [TODO.md](TODO.md) | What is still unverified against Fiken |
