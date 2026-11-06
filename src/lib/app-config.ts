import { parseConfig } from "@/lib/config.ts"
import configJson from "../../regnskap.config.json"

/** The recipe, built into the app from regnskap.config.json. */
export const config = parseConfig(configJson, "regnskap.config.json")

/** Same-origin proxy to api.fiken.no (nginx in production, a Next rewrite in dev). */
export const API_BASE = "/api/fiken"

/** Mock mode (`pnpm dev:mock`): Fiken is an in-memory fake in the browser. Never in a build. */
export const MOCK = process.env.NEXT_PUBLIC_FIKEN_MOCK === "1"
