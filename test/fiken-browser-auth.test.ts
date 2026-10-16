import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubEnv("NEXT_PUBLIC_FIKEN_CLIENT_ID", "test-client")
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  store.set(
    "fiken.token",
    JSON.stringify({ accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1 }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

const tokenResponse = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

describe("completeLogin", () => {
  beforeEach(() => {
    store.set("fiken.pending-login", JSON.stringify({ verifier: "v", state: "s", returnTo: "/" }))
  })

  it("reports Fiken's error even when the redirect has no state", async () => {
    const { completeLogin } = await import("../src/lib/fiken-browser-auth.ts")

    await expect(completeLogin(new URLSearchParams("error=access_denied"))).rejects.toThrow(
      "avbrutt eller avslått",
    )
    expect(store.has("fiken.pending-login")).toBe(false)
  })

  it("passes on Fiken's description for other errors", async () => {
    const { completeLogin } = await import("../src/lib/fiken-browser-auth.ts")

    await expect(
      completeLogin(new URLSearchParams("error=server_error&error_description=Noe+gikk+galt")),
    ).rejects.toThrow("Noe gikk galt")
  })
})

describe("browserAuth", () => {
  it("spends the refresh token once when token() and refresh() run together", async () => {
    const fetch = vi.fn(async () =>
      tokenResponse({
        access_token: "new",
        refresh_token: "r2",
        token_type: "bearer",
        expires_in: 3600,
      }),
    )
    vi.stubGlobal("fetch", fetch)
    const { browserAuth } = await import("../src/lib/fiken-browser-auth.ts")

    const [token, refreshed] = await Promise.all([browserAuth.token(), browserAuth.refresh()])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(token).toBe("new")
    expect(refreshed).toBe(true)
    expect(JSON.parse(store.get("fiken.token") ?? "{}").refreshToken).toBe("r2")
  })

  it("logs out when Fiken refuses the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ error: "invalid_grant" }, 400)),
    )
    const { browserAuth, isLoggedIn } = await import("../src/lib/fiken-browser-auth.ts")

    expect(await browserAuth.refresh()).toBe(false)
    expect(isLoggedIn()).toBe(false)
  })
})
