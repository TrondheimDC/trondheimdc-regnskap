import { parseConfig } from "@/lib/config.ts"
import configJson from "../../regnskap.config.json"

/** The recipe, built into the app from regnskap.config.json. */
export const config = parseConfig(configJson, "regnskap.config.json")

/** Same-origin proxy to api.fiken.no (nginx in production, a Next rewrite in dev). */
export const API_BASE = "/api/fiken"

/** Mock mode (`pnpm dev:mock`): Fiken is an in-memory fake in the browser. Never in a build. */
export const MOCK = process.env.NEXT_PUBLIC_FIKEN_MOCK === "1"

/**
 * Public half of the test key the mock signs its Min TDC reports with (test/min-tdc-fixture.ts).
 * A test key: nothing real is ever signed with it.
 */
const MOCK_REPORT_PUBLIC_KEY = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw="

/** Min TDC's public key, to check the signature on utleggsrapporter it uploads to the inbox. */
export const REPORT_PUBLIC_KEY = MOCK ? MOCK_REPORT_PUBLIC_KEY : config.utlegg?.minTdc?.publicKey
