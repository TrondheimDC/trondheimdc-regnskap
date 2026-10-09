// Fiken OAuth2 for a CLI: authorization code flow with PKCE as a public client (no secret),
// with a loopback redirect to a short-lived local server. Tokens are stored in the user's
// config dir and refreshed automatically. A personal API token (FIKEN_API_TOKEN) still wins.
//
// Fiken rotates refresh tokens for public clients: every refresh returns a new one that must be
// stored before the old is discarded; reusing an old one may revoke the whole chain.

import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { Auth } from "../lib/fiken.ts"

// FIKEN_OAUTH_URL is only meant for testing against a local mock.
const OAUTH_URL = process.env.FIKEN_OAUTH_URL ?? "https://fiken.no/oauth"
const AUTHORIZE_URL = `${OAUTH_URL}/authorize`
const TOKEN_URL = `${OAUTH_URL}/token`
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8723/callback"
/** Refresh a minute before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000

const TOKEN_FILE = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "trondheimdc-regnskap",
  "oauth-token.json",
)

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
})

const StoredToken = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Epoch ms. */
  expiresAt: z.number(),
  clientId: z.string(),
})
type StoredToken = z.infer<typeof StoredToken>

function oauthClient() {
  const clientId = process.env.FIKEN_CLIENT_ID ?? process.env.NEXT_PUBLIC_FIKEN_CLIENT_ID
  if (!clientId) {
    throw new Error(
      "Missing NEXT_PUBLIC_FIKEN_CLIENT_ID in .env (the Client ID of your Fiken app, see README: Innlogging)",
    )
  }
  return {
    clientId,
    clientSecret: process.env.FIKEN_CLIENT_SECRET || undefined,
    redirectUri: process.env.FIKEN_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
  }
}

async function readToken(): Promise<StoredToken | undefined> {
  const raw = await readFile(TOKEN_FILE, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const parsed = StoredToken.safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data : undefined
}

async function saveToken(token: StoredToken) {
  await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 })
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 })
  await chmod(TOKEN_FILE, 0o600)
}

/** POSTs to the token endpoint, as a public client (PKCE) or with Basic auth if a secret is configured. */
async function requestToken(
  params: Record<string, string>,
  clientId: string,
): Promise<StoredToken> {
  const { clientSecret } = oauthClient()
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }
  const body = new URLSearchParams(params)
  if (clientSecret) headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`
  else body.set("client_id", clientId)

  const res = await fetch(TOKEN_URL, { method: "POST", headers, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`Fiken token request failed with ${res.status}: ${text}`)
  const token = TokenResponse.parse(JSON.parse(text))
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    clientId,
  }
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
  } catch {
    // No browser available; the URL is printed anyway.
  }
}

/** Runs the browser login and stores the tokens. */
export async function login(): Promise<void> {
  const { clientId, redirectUri } = oauthClient()
  const redirect = new URL(redirectUri)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
    throw new Error(
      `FIKEN_REDIRECT_URI must be a loopback address for the CLI login, got ${redirectUri}`,
    )
  }

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)))

  const authorizeUrl = new URL(AUTHORIZE_URL)
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    authorizeUrl.searchParams.set(k, v)
  }

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error("Timed out waiting for the Fiken login (5 minutes)"))
    }, 5 * 60_000)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri)
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found")
        return
      }
      const finish = (message: string, result: () => void) => {
        clearTimeout(timeout)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        res.end(`<!doctype html><meta charset="utf-8"><p>${message}</p>`)
        server.close()
        result()
      }
      const error = url.searchParams.get("error")
      if (error)
        return finish("Innlogging avbrutt. Du kan lukke vinduet.", () =>
          reject(new Error(`Fiken login failed: ${error}`)),
        )
      if (url.searchParams.get("state") !== state) {
        return finish("Ugyldig state. Prøv på nytt.", () =>
          reject(new Error("OAuth state mismatch, try again")),
        )
      }
      const code = url.searchParams.get("code")
      if (!code)
        return finish("Mangler kode. Prøv på nytt.", () =>
          reject(new Error("No authorization code in redirect")),
        )
      return finish("Innlogget i Fiken. Du kan lukke vinduet og gå tilbake til terminalen.", () =>
        resolve(code),
      )
    })
    server.on("error", reject)
    server.listen(Number(redirect.port || 80), redirect.hostname.replace(/^\[|\]$/g, ""))

    console.log(
      `Åpne denne lenken for å logge inn i Fiken (åpnes automatisk hvis mulig):\n\n  ${authorizeUrl}\n`,
    )
    openBrowser(authorizeUrl.toString())
  })

  const token = await requestToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      state,
      code_verifier: verifier,
    },
    clientId,
  )
  await saveToken(token)
  console.log(`Innlogget. Token lagret i ${TOKEN_FILE}`)
}

export async function logout(): Promise<void> {
  await rm(TOKEN_FILE, { force: true })
  console.log("Logget ut (lagret token slettet).")
}

/** Personal token from FIKEN_API_TOKEN if set, otherwise the stored OAuth token. */
export async function createAuth(): Promise<Auth> {
  const personal = process.env.FIKEN_API_TOKEN
  if (personal) return { token: async () => personal, refresh: async () => false }

  let stored = await readToken()
  if (!stored)
    throw new Error(
      "Not logged in to Fiken. Run `pnpm foring login` first (or set FIKEN_API_TOKEN).",
    )

  const refresh = async () => {
    // Save the rotated refresh token before using the new access token.
    stored = await requestToken(
      { grant_type: "refresh_token", refresh_token: stored!.refreshToken },
      stored!.clientId,
    )
    await saveToken(stored)
    return true
  }

  return {
    async token() {
      if (stored!.expiresAt - EXPIRY_MARGIN_MS < Date.now()) await refresh()
      return stored!.accessToken
    },
    refresh,
  }
}

/** True if we have some way to talk to Fiken without prompting. */
export async function hasCredentials(): Promise<boolean> {
  return Boolean(process.env.FIKEN_API_TOKEN) || (await readToken()) !== undefined
}
