// Fiken OAuth in the browser: authorization code + PKCE as a public client (no secret).
// fiken.no/oauth/token allows CORS, so the code exchange happens right here. Tokens live in
// sessionStorage: they disappear with the tab, and nothing is stored on any server.
//
// Fiken rotates refresh tokens for public clients; the new one is stored before it is used.

import type { Auth } from "@/lib/fiken.ts"

// NEXT_PUBLIC_FIKEN_OAUTH_URL is only meant for end-to-end tests against a local mock.
const OAUTH_URL = process.env.NEXT_PUBLIC_FIKEN_OAUTH_URL || "https://fiken.no/oauth"
const AUTHORIZE_URL = `${OAUTH_URL}/authorize`
const TOKEN_URL = `${OAUTH_URL}/token`
const EXPIRY_MARGIN_MS = 60_000

const TOKEN_KEY = "fiken.token"
const PENDING_KEY = "fiken.pending-login"

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function clientId(): string {
  const id = process.env.NEXT_PUBLIC_FIKEN_CLIENT_ID
  if (!id) throw new Error("NEXT_PUBLIC_FIKEN_CLIENT_ID mangler i bygget")
  return id
}

const redirectUri = () => `${window.location.origin}/auth/callback`

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const randomString = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)))

function readToken(): StoredToken | undefined {
  const raw = sessionStorage.getItem(TOKEN_KEY)
  return raw ? (JSON.parse(raw) as StoredToken) : undefined
}

async function requestToken(params: Record<string, string>): Promise<StoredToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: clientId() }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(
      `Innlogging feilet (${res.status}): ${json.error_description ?? json.error ?? "ukjent feil"}`,
    )
  }
  const token = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  }
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return token
}

/** Sends the browser to Fiken's login. */
export async function startLogin(): Promise<void> {
  const verifier = randomString(48)
  const state = randomString(24)
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state }))

  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  window.location.assign(url.toString())
}

/** Handles the redirect back from Fiken (on /auth/callback). */
export async function completeLogin(params: URLSearchParams): Promise<void> {
  const pending = sessionStorage.getItem(PENDING_KEY)
  sessionStorage.removeItem(PENDING_KEY)
  const error = params.get("error")
  if (error) throw new Error(`Innlogging avbrutt: ${params.get("error_description") ?? error}`)
  if (!pending) throw new Error("Fant ingen påbegynt innlogging i denne fanen. Prøv igjen.")

  const { verifier, state } = JSON.parse(pending) as { verifier: string; state: string }
  if (params.get("state") !== state)
    throw new Error("Ugyldig innlogging (state stemmer ikke). Prøv igjen.")
  const code = params.get("code")
  if (!code) throw new Error("Fiken sendte ingen kode tilbake. Prøv igjen.")

  await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  })
}

export function isLoggedIn(): boolean {
  return readToken() !== undefined
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

/** Auth for the Fiken client; refreshes the access token when needed. */
export const browserAuth: Auth = {
  async token() {
    let token = readToken()
    if (!token) throw new Error("Ikke innlogget")
    if (token.expiresAt - EXPIRY_MARGIN_MS < Date.now()) {
      token = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken })
    }
    return token.accessToken
  },
  async refresh() {
    const token = readToken()
    if (!token) return false
    try {
      await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken })
      return true
    } catch {
      logout()
      return false
    }
  },
}
