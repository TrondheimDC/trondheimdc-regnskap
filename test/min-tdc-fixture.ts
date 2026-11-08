// Signs utleggsrapporter the way Min TDC does (its src/lib/report-signature.ts), for the tests
// and the mock. The key is a TEST key from a fixed, obviously fake seed. Nothing real is ever
// signed with it, and regnskap.config.json never holds it.

import {
  base64urlEncode,
  fieldsOf,
  type ReportAttestation,
  sha256Base64url,
  signedMessage,
  TOKEN_PREFIX,
} from "../src/lib/min-tdc.ts"
import { utleggPdfV2 } from "./pdf-fixture.ts"

/** PKCS#8 DER of an Ed25519 key is this header followed by the 32-byte seed. */
const PKCS8_HEADER = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]
const TEST_SEED = new Uint8Array(32).fill(7)

/** Public half of the test key, base64 SPKI DER. Also in src/lib/app-config.ts for the mock. */
export const TEST_PUBLIC_KEY = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw="

export function testSigningKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array([...PKCS8_HEADER, ...TEST_SEED]),
    { name: "Ed25519" },
    true,
    ["sign"],
  )
}

/** A fresh key pair, for "another key". */
export async function otherKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: btoa(String.fromCharCode(...spki)) }
}

/** `mintdc1 year=… roles=… email=… [login=…] sig=…`, as Min TDC's `signReport`. */
export async function signReport(
  attestation: ReportAttestation,
  pdf: Uint8Array,
  key: CryptoKey | Promise<CryptoKey> = testSigningKey(),
): Promise<string> {
  const fields = fieldsOf(attestation)
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      await key,
      signedMessage(await sha256Base64url(pdf), fields),
    ),
  )
  return `${TOKEN_PREFIX} ${fields} sig=${base64urlEncode(signature)}`
}

/** The description Min TDC gives the inbox document: `Min TDC · Sum … · <signature>`. */
export async function minTdcDescription(
  pdf: Uint8Array,
  attestation: ReportAttestation,
  sum: string,
  key?: CryptoKey | Promise<CryptoKey>,
): Promise<string> {
  return ["Min TDC", `Sum ${sum}`, await signReport(attestation, pdf, key)].join(" · ")
}

/** A speaker who logged in with another address than the one on the report. */
export const MIN_TDC_SENDER: ReportAttestation = {
  year: 2030,
  roles: ["attendee", "speaker"],
  email: "ola@example.com",
  login: "ola.testesen@example.org",
}

/** A speaker's travel, sent through Min TDC. */
export const MIN_TDC_REPORT = utleggPdfV2({
  reportId: "UT-20301107-M1N2",
  generated: "07.11.2030",
  name: "Ola Testesen",
  email: "ola@example.com",
  bank: [["Kontonummer", "1234 56 78903"]],
  receipts: [
    {
      description: "Fly Oslo - Trondheim tur/retur",
      date: "28.10.2030",
      category: "Reise",
      payout: 289000,
      text: ["Flyselskapet AS", "Totalt 2 890,00", "Herav mva 12% 309,64"],
    },
    {
      description: "Flytoget Værnes - Trondheim S",
      date: "29.10.2030",
      category: "Reise",
      payout: 56000,
    },
  ],
})

/** Someone else's report, to put Ola's signature next to. */
export const OTHER_REPORT = utleggPdfV2({
  reportId: "UT-20301108-X9Y8",
  generated: "08.11.2030",
  name: "Per Testesen",
  email: "per@example.com",
  bank: [["Kontonummer", "1234 56 78903"]],
  receipts: [
    {
      description: "Taxi til konferansen",
      date: "29.10.2030",
      category: "Reise",
      payout: 345000,
    },
  ],
})
