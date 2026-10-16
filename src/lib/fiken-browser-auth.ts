// Fiken OAuth in the browser: authorization code + PKCE as a public client (no secret).
// fiken.no/oauth/token allows CORS, so the code exchange happens right here. Tokens live in
// sessionStorage: they disappear with the tab, and nothing is stored on any server.
//
// The OAuth protocol is oauth4webapi's. Fiken rotates refresh tokens for public clients; the new
// one is stored before it is used, and only one refresh runs at a time.

import * as oauth from "oauth4webapi"
import type { Auth } from "@/lib/fiken.ts"

// NEXT_PUBLIC_FIKEN_OAUTH_URL is only meant for end-to-end tests against a local mock.
const OAUTH_URL = process.env.NEXT_PUBLIC_FIKEN_OAUTH_URL || "https://fiken.no/oauth"
const EXPIRY_MARGIN_MS = 60_000

const TOKEN_KEY = "fiken.token"
const PENDING_KEY = "fiken.pending-login"

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// Fiken has no discovery, so its endpoints are given here.
const as: oauth.AuthorizationServer = {
  issuer: new URL(OAUTH_URL).origin,
  authorization_endpoint: `${OAUTH_URL}/authorize`,
  token_endpoint: `${OAUTH_URL}/token`,
}
// Checked at build time in next.config.ts.
const client: oauth.Client = { client_id: process.env.NEXT_PUBLIC_FIKEN_CLIENT_ID as string }
// Plain http only for the local mock.
const options = { [oauth.allowInsecureRequests]: OAUTH_URL.startsWith("http:") }

const redirectUri = () => `${window.location.origin}/auth/callback`

function readToken(): StoredToken | undefined {
  const raw = sessionStorage.getItem(TOKEN_KEY)
  return raw ? (JSON.parse(raw) as StoredToken) : undefined
}

function storeToken(response: oauth.TokenEndpointResponse): StoredToken {
  const token = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token as string,
    expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
  }
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return token
}

/** Sends the browser to Fiken's login. */
export async function startLogin(): Promise<void> {
  const verifier = oauth.generateRandomCodeVerifier()
  const state = oauth.generateRandomState()
  // Come back to the bilag that was open, not just the front page.
  const returnTo = window.location.pathname + window.location.search
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo }))

  const url = new URL(as.authorization_endpoint as string)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri(),
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  }).toString()
  window.location.assign(url)
}

/** Handles the redirect back from Fiken (on /auth/callback). Returns the path to go back to. */
export async function completeLogin(params: URLSearchParams): Promise<string> {
  const pending = sessionStorage.getItem(PENDING_KEY)
  sessionStorage.removeItem(PENDING_KEY)
  // Fiken's own reason comes first: an error redirect may carry no state, and
  // validateAuthResponse would report that instead.
  const error = params.get("error")
  if (error) {
    throw new Error(
      error === "access_denied"
        ? "Innloggingen ble avbrutt eller avslått i Fiken."
        : `Fiken avviste innloggingen: ${params.get("error_description") ?? error}`,
    )
  }
  if (!pending) throw new Error("Fant ingen påbegynt innlogging i denne fanen. Prøv igjen.")
  const { verifier, state, returnTo } = JSON.parse(pending)

  const callback = oauth.validateAuthResponse(as, client, params, state)
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.None(),
    callback,
    redirectUri(),
    verifier,
    options,
  )
  storeToken(await oauth.processAuthorizationCodeResponse(as, client, response))
  // Only a path on this site; "//host" would leave it.
  return returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/"
}

export function isLoggedIn(): boolean {
  return readToken() !== undefined
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

let refreshing: Promise<StoredToken | undefined> | null = null

// One refresh at a time: a second one would spend the rotated refresh token twice.
function refresh(refreshToken: string) {
  refreshing ??= oauth
    .refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, options)
    .then((response) => oauth.processRefreshTokenResponse(as, client, response))
    .then(storeToken)
    .catch(() => {
      logout()
      return undefined
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

/** Auth for the Fiken client; refreshes the access token when needed. */
export const browserAuth: Auth = {
  async token() {
    let token = readToken()
    if (token && token.expiresAt - EXPIRY_MARGIN_MS < Date.now())
      token = await refresh(token.refreshToken)
    if (!token) throw new Error("Ikke innlogget")
    return token.accessToken
  },
  async refresh() {
    const token = readToken()
    return token !== undefined && (await refresh(token.refreshToken)) !== undefined
  },
}
