// Did an utleggsrapport in the Fiken inbox come through Min TDC (trondheimdc-min)?
//
// Anyone can put a file in the Fiken inbox (it takes mail too), so "Min TDC" in the description
// proves nothing. Min TDC signs every report it uploads with an Ed25519 key only it has, and ends
// the description with
//
//   mintdc1 year=2026 roles=speaker,crew email=kari@privat.no login=kari@jobb.no sig=<signature>
//
// `login` is only there when it differs from `email`. `sig` is base64url of the Ed25519 signature
// over the UTF-8 bytes of
//
//   "mintdc1\n" + base64url(SHA-256 of the PDF) + "\n" + the fields exactly as written
//
// (everything between "mintdc1 " and " sig="). The PDF's hash is signed but not written down: we
// compute it from the PDF we downloaded, so a changed or swapped PDF doesn't verify, and report id,
// name, sums and bank account in the PDF are covered too. We keep only the public key, so we can
// check but never sign. The format is Min TDC's `src/lib/report-signature.ts`.
//
// A report is verified only when the signature holds for this PDF AND the PDF's email is `email`
// (Min TDC checked the address the form sent, not the PDF). Uses Web Crypto, so it runs in the
// browser and in the tests.
//
// Verification is information for the reviewer. It never changes how a report is booked.

import { z } from "zod"
import type { Utleggsrapport } from "./utlegg.ts"

export const TOKEN_PREFIX = "mintdc1"

const TOKEN = /mintdc1 (\S.*?) sig=([A-Za-z0-9_-]{86})(?![A-Za-z0-9_-])/g

/** An Ed25519 public key as base64 SPKI DER: a fixed 12-byte header, then the 32-byte key. */
export const Ed25519PublicKey = z
  .string()
  .trim()
  .regex(
    /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/,
    "Expected an Ed25519 public key as base64 SPKI DER (starts with MCowBQYDK2VwAyEA)",
  )

/** What Min TDC vouches for: the sender, and what they were at TDC that year. */
export interface ReportAttestation {
  year: number
  /** By TDC's lists that year, e.g. `["speaker"]`. */
  roles: string[]
  /** The address on the report: the login's, or another the person confirmed by a mailed link. */
  email: string
  /** The address they logged in with, the one on TDC's lists. Same as `email` when not written. */
  login: string
}

export type MinTdcResult =
  /** No signature: mailed, or from utlegg.trondheimdc.no. The normal case before Min TDC. */
  | { status: "unsigned" }
  | { status: "verified"; attestation: ReportAttestation }
  /** A signature, but the recipe has no public key to check it with. */
  | { status: "no-key" }
  /**
   * A signature that doesn't hold for this PDF: forged or changed fields, or a changed or swapped
   * PDF (they can't be told apart). Or it holds, but the PDF names another email.
   */
  | { status: "failed"; problems: string[] }

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** SHA-256 of the file, base64url: part of what the signature covers. */
export async function sha256Base64url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  return base64urlEncode(new Uint8Array(digest))
}

/** The bytes the signature is over. */
export function signedMessage(pdfSha256: string, fields: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${TOKEN_PREFIX}\n${pdfSha256}\n${fields}`)
}

/** `year=2026 roles=speaker,crew email=… login=…`, login only when it differs. */
export function fieldsOf({ year, roles, email, login }: ReportAttestation): string {
  return [
    `year=${year}`,
    `roles=${roles.join(",")}`,
    `email=${email}`,
    ...(login === email ? [] : [`login=${login}`]),
  ].join(" ")
}

function parseFields(fields: string): ReportAttestation | undefined {
  const values = new Map(
    fields.split(" ").map((field) => {
      const at = field.indexOf("=")
      return [field.slice(0, at), field.slice(at + 1)] as const
    }),
  )
  const year = Number(values.get("year"))
  const email = values.get("email")
  if (!Number.isInteger(year) || !email) return undefined
  return {
    year,
    roles: values.get("roles")?.split(",").filter(Boolean) ?? [],
    email,
    login: values.get("login") ?? email,
  }
}

const same = (a: string | undefined, b: string) =>
  a?.trim().toLowerCase() === b.trim().toLowerCase()

const NOT_VERIFIED =
  "Signaturen stemmer ikke med denne PDF-en og Min TDCs nøkkel. PDF-en er byttet eller endret, eller feltene i beskrivelsen er skrevet om."

/**
 * Checks a report from the inbox: the signature in its description against the PDF exactly as
 * downloaded and the public key (base64 SPKI DER), then the PDF's email against the signed one.
 */
export async function verifyMinTdcReport(input: {
  /** The inbox document's description. */
  description: string | null | undefined
  /** The PDF exactly as downloaded from the inbox. */
  pdf: Uint8Array
  /** What we read from that PDF. */
  report: Pick<Utleggsrapport, "email">
  publicKey: string | undefined
}): Promise<MinTdcResult> {
  const text = input.description ?? ""
  if (!/\bmintdc1\b/.test(text)) return { status: "unsigned" }
  const failed = (problem: string): MinTdcResult => ({ status: "failed", problems: [problem] })

  const matches = [...text.matchAll(TOKEN)]
  if (matches.length > 1) return failed("Beskrivelsen har mer enn én Min TDC-signatur.")
  const [, fields, signature] = matches[0] ?? []
  if (!fields || !signature)
    return failed(
      "Signaturen er ufullstendig. Er beskrivelsen kuttet av, eller skrevet om etter opplastingen?",
    )
  if (!input.publicKey) return { status: "no-key" }

  let valid: boolean
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      base64urlDecode(input.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64urlDecode(signature),
      signedMessage(await sha256Base64url(input.pdf), fields),
    )
  } catch {
    valid = false
  }
  if (!valid) return failed(NOT_VERIFIED)

  const attestation = parseFields(fields)
  if (!attestation) return failed("Signaturen holder, men feltene kan ikke leses (år og e-post).")
  if (!same(input.report.email, attestation.email))
    return failed(
      `E-posten i PDF-en er ${input.report.email ?? "ikke lest"}, men Min TDC bekreftet ${attestation.email}.`,
    )
  return { status: "verified", attestation }
}

const ROLE_LABELS: Record<string, string> = {
  speaker: "foredragsholder",
  crew: "crew",
  volunteer: "frivillig",
  attendee: "deltaker",
}

/** "foredragsholder og crew 2026". Attendee is left out next to a real role. */
export function describeRoles(a: Pick<ReportAttestation, "roles" | "year">): string {
  const roles = a.roles.length > 1 ? a.roles.filter((r) => r !== "attendee") : a.roles
  const labels = roles.map((r) => ROLE_LABELS[r] ?? r)
  return labels.length > 0 ? `${labels.join(" og ")} ${a.year}` : `ingen rolle ${a.year}`
}

/** Who Min TDC vouches for: "kari@privat.no · innlogget som kari@jobb.no · foredragsholder 2026". */
export function describeAttestation(a: ReportAttestation): string {
  const login = same(a.login, a.email) ? [] : [`innlogget som ${a.login}`]
  return [a.email, ...login, describeRoles(a)].join(" · ")
}

export interface MinTdcSummary {
  tone: "ok" | "warning" | "error"
  title: string
  detail: string
  /** What went wrong, for a failed check. */
  problems: string[]
}

/**
 * What the review shows about the sender. Undefined for an unsigned report: most reports
 * aren't from Min TDC, so only a signature is worth a mention.
 */
export function summarizeMinTdc(result: MinTdcResult): MinTdcSummary | undefined {
  switch (result.status) {
    case "verified":
      return {
        tone: "ok",
        title: "Fra Min TDC – verifisert",
        detail: describeAttestation(result.attestation),
        problems: [],
      }
    case "unsigned":
      return undefined
    case "no-key":
      return {
        tone: "warning",
        title: "Signert av Min TDC, men ikke sjekket",
        detail:
          "Oppskriften mangler Min TDCs offentlige nøkkel (utlegg.minTdc.publicKey i regnskap.config.json).",
        problems: [],
      }
    case "failed":
      return {
        tone: "error",
        title: "Min TDC-signaturen stemmer ikke",
        detail:
          "Mulig forfalsket. Behandle rapporten som ukjent avsender og sjekk med personen før du fører.",
        problems: result.problems,
      }
  }
}
