# Deploy — regnskap.trondheimdc.no

A static site (Next.js `output: "export"`), the same way as utlegg. The only difference: nginx also proxies `/api/fiken/*` to `api.fiken.no`, because Fiken's API has no CORS.

There is no app server, no database and no secret on the server. The login is OAuth with PKCE in the browser, and the token lives only in the browser tab (sessionStorage).

GitHub Actions are off (`workflow_dispatch` only) until we are ready to deploy. The intended pipeline:

```text
push to main
    → GitHub Actions: lint, typecheck, test, next build (NEXT_PUBLIC_FIKEN_CLIENT_ID)
    → rsync out/ → /var/www/sites/regnskap.trondheimdc.no/public
```

| Part | Value |
|---|---|
| Public URL | https://regnskap.trondheimdc.no |
| Static files | `/var/www/sites/regnskap.trondheimdc.no/public` |
| Fiken proxy | `https://regnskap.trondheimdc.no/api/fiken/*` → `https://api.fiken.no/api/v2/*` |
| Nginx logs | `/var/www/sites/regnskap.trondheimdc.no/logs/` |

## 1. Fiken app (one-time)

1. In Fiken: *Rediger konto → Profil → Andre innstillinger* → tick that you are a developer.
2. *Rediger konto → API* → **Ny app**:
   - **Uten client secret (PKCE)**: **tick it.** This can only be chosen when the app is created.
   - **Kun lesetilgang**: do **not** tick it. The app has to create sales, purchases and journal entries (fri posteringer).
   - **Redirect URIs**:
     - `https://regnskap.trondheimdc.no/auth/callback` (web)
     - `http://localhost:3000/auth/callback` (local `pnpm dev`)
     - `http://127.0.0.1:8723/callback` (CLI, `pnpm foring login`)
   - **Godkjente brukere**: everyone who should be able to book. In development status, only they can log in, with at most 5 users.
3. Copy the Client ID. It isn't secret.

The company must have the API module enabled (*Innstillinger → Moduler*).

## 2. GitHub (one-time)

| Type | Name | Value |
|---|---|---|
| Variable | `FIKEN_CLIENT_ID` | Client ID from step 1 |
| Secret | `SSH_HOST` / `SSH_USER` / `SSH_PRIVATE_KEY` | Same as utlegg |

## 3. Server (one-time)

```bash
sudo mkdir -p /var/www/sites/regnskap.trondheimdc.no/{public,logs}
sudo chown -R "$DEPLOY_USER" /var/www/sites/regnskap.trondheimdc.no/public
sudo chown root:adm /var/www/sites/regnskap.trondheimdc.no/logs
```

DNS: `regnskap.trondheimdc.no` → the VPS. That's a CNAME to `worldwide.trondheimdc.no`, like innsjekk.

Nginx and TLS:

```bash
sudo cp docs/nginx-regnskap.trondheimdc.no.conf /etc/nginx/sites-available/regnskap.trondheimdc.no
# Before the certificate exists: temporarily comment out the 443 server block, then
sudo ln -sf /etc/nginx/sites-available/regnskap.trondheimdc.no /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d regnskap.trondheimdc.no
# Enable the 443 block again (keep certbot's ssl_certificate* lines), then
sudo nginx -t && sudo systemctl reload nginx
```

The proxy uses `proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt`, the Debian/Ubuntu path. Adjust it if the host differs.

## 4. Verify after deploy

```bash
curl -sI https://regnskap.trondheimdc.no | head -1                       # 200
curl -sI https://regnskap.trondheimdc.no/auth/callback | head -1         # 200
curl -s -o /dev/null -w "%{http_code}\n" https://regnskap.trondheimdc.no/api/fiken/companies   # 401 from Fiken = the proxy works
```

Then log in on a phone and open a regnskapsbilag. Nothing is written until you confirm.

## Why a proxy, and what it can do

`api.fiken.no` doesn't answer CORS preflight, so the browser can't call it from another domain. `fiken.no/oauth/token` does allow CORS, so the login itself goes straight to Fiken. The proxy:

- only forwards to `api.fiken.no/api/v2/`, unchanged;
- holds no credentials. Every request carries the logged-in user's own Fiken token, so the proxy is useless without one;
- strips cookies, `Origin` and `Referer`, and sets `Cache-Control: no-store`.

## Local development

```bash
cp .env.example .env.local     # NEXT_PUBLIC_FIKEN_CLIENT_ID=...
pnpm install
pnpm dev                    # http://localhost:3000; Next proxies /api/fiken like nginx
```
