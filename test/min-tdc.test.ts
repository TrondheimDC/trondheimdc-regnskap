import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { parseConfig } from "../src/lib/config.ts"
import {
  describeAttestation,
  type ReportAttestation,
  summarizeMinTdc,
  verifyMinTdcReport,
} from "../src/lib/min-tdc.ts"
import { parseUtleggPdf } from "../src/lib/utlegg.ts"
import { readUtleggSource } from "../src/lib/utlegg-booking.ts"
import {
  MIN_TDC_REPORT,
  MIN_TDC_SENDER,
  minTdcDescription,
  OTHER_REPORT,
  otherKeyPair,
  signReport,
  TEST_PUBLIC_KEY,
  testSigningKey,
} from "./min-tdc-fixture.ts"

const report = { email: "ola@example.com" }
const check = (
  description: string | undefined,
  pdf = MIN_TDC_REPORT,
  publicKey = TEST_PUBLIC_KEY,
) => verifyMinTdcReport({ description, pdf, report, publicKey })

describe("Min TDC signature", () => {
  test("a report from Min TDC verifies", async () => {
    const description = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "3 450,00 kr")
    expect(description).toMatch(
      /^Min TDC · Sum 3 450,00 kr · mintdc1 year=2030 roles=attendee,speaker email=ola@example\.com login=ola\.testesen@example\.org sig=[\w-]{86}$/,
    )
    const result = await check(description)
    expect(result).toEqual({ status: "verified", attestation: MIN_TDC_SENDER })
    expect(summarizeMinTdc(result).title).toBe("Fra Min TDC – verifisert")
    expect(describeAttestation(MIN_TDC_SENDER)).toBe(
      "ola@example.com · innlogget som ola.testesen@example.org · foredragsholder 2030",
    )
  })

  test("login is the email when it isn't written; the email compares case-insensitively", async () => {
    const sender: ReportAttestation = {
      ...MIN_TDC_SENDER,
      roles: ["speaker", "crew"],
      login: "ola@example.com",
    }
    const token = await signReport(sender, MIN_TDC_REPORT)
    expect(token).not.toContain("login=")
    const result = await verifyMinTdcReport({
      description: token,
      pdf: MIN_TDC_REPORT,
      report: { email: "Ola@Example.COM" },
      publicKey: TEST_PUBLIC_KEY,
    })
    expect(result).toEqual({ status: "verified", attestation: sender })
    expect(describeAttestation(sender)).toBe("ola@example.com · foredragsholder og crew 2030")
  })

  test("a token made the way Min TDC makes it (node:crypto) verifies", async () => {
    // A port of Min TDC's signReport, so Web Crypto here and node:crypto there agree.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const fields = "year=2030 roles=crew email=ola@example.com"
    const hash = createHash("sha256").update(MIN_TDC_REPORT).digest("base64url")
    const sig = sign(null, Buffer.from(`mintdc1\n${hash}\n${fields}`), privateKey)
    const result = await check(
      `Min TDC · Sum 1 kr · mintdc1 ${fields} sig=${sig.toString("base64url")}`,
      MIN_TDC_REPORT,
      publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    )
    expect(result.status).toBe("verified")
  })

  test("changed fields don't verify", async () => {
    const description = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "3 450,00 kr")
    for (const forged of [
      description.replace("roles=attendee,speaker", "roles=attendee,crew"),
      description.replace("year=2030", "year=2031"),
      description.replace(" login=ola.testesen@example.org", ""),
    ]) {
      const result = await check(forged)
      expect(result.status).toBe("failed")
      expect(summarizeMinTdc(result).tone).toBe("error")
    }
  })

  test("another key doesn't verify", async () => {
    const other = await otherKeyPair()
    const forged = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "1 kr", other.privateKey)
    expect((await check(forged)).status).toBe("failed")
    const genuine = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "1 kr")
    expect((await check(genuine, MIN_TDC_REPORT, other.publicKey)).status).toBe("failed")
  })

  test("a changed or swapped PDF doesn't verify", async () => {
    const description = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "1 kr")
    const changed = MIN_TDC_REPORT.slice()
    changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1
    expect((await check(description, changed)).status).toBe("failed")
    expect((await check(description, OTHER_REPORT)).status).toBe("failed")
  })

  test("a genuine signature over a PDF with another email is flagged", async () => {
    // Min TDC checks the address the form sent, not what the PDF says.
    const description = await minTdcDescription(OTHER_REPORT, MIN_TDC_SENDER, "1 kr")
    const other = await parseUtleggPdf(OTHER_REPORT)
    const result = await verifyMinTdcReport({
      description,
      pdf: OTHER_REPORT,
      report: other,
      publicKey: TEST_PUBLIC_KEY,
    })
    expect(result).toEqual({
      status: "failed",
      problems: ["E-posten i PDF-en er per@example.com, men Min TDC bekreftet ola@example.com."],
    })
  })

  test("a cut-off or doubled signature is flagged, not taken as unsigned", async () => {
    const description = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "1 kr")
    expect((await check(description.slice(0, -10))).status).toBe("failed")
    expect((await check(description.slice(0, 40))).status).toBe("failed")
    const token = description.slice(description.indexOf("mintdc1"))
    expect((await check(`${description} · ${token.replace("2030", "2031")}`)).status).toBe("failed")
  })

  test("no token is not from Min TDC", async () => {
    for (const description of [undefined, "", "Min TDC · Sum 1 kr · ola@example.com"])
      expect(await check(description)).toEqual({ status: "unsigned" })
  })

  test("a token without a configured key is shown as not checked", async () => {
    const description = await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "1 kr")
    expect(
      await verifyMinTdcReport({ description, pdf: MIN_TDC_REPORT, report, publicKey: undefined }),
    ).toEqual({ status: "no-key" })
  })

  test("the test key's public half is the one in the fixture and the mock", async () => {
    const jwk = await crypto.subtle.exportKey("jwk", await testSigningKey())
    const raw = Buffer.from(jwk.x ?? "", "base64url")
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw])
    expect(spki.toString("base64")).toBe(TEST_PUBLIC_KEY)
    const appConfig = await readFile(new URL("../src/lib/app-config.ts", import.meta.url), "utf8")
    expect(appConfig).toContain(`MOCK_REPORT_PUBLIC_KEY = "${TEST_PUBLIC_KEY}"`)
  })

  test("an inbox document is checked when it is read; a local file is not", async () => {
    const doc = {
      documentId: 1,
      name: "Refusjon TDC 2030 – Ola Testesen (UT-20301107-M1N2)",
      filename: "UT-20301107-M1N2-ola-testesen-expense-report.pdf",
      description: await minTdcDescription(MIN_TDC_REPORT, MIN_TDC_SENDER, "3 450,00 kr"),
      status: false,
      createdAt: "2030-11-07T10:00:00Z",
      documentUrl: "https://api.fiken.no/api/v2/x",
    }
    const source = await readUtleggSource(MIN_TDC_REPORT, { doc, publicKey: TEST_PUBLIC_KEY }, "x")
    expect(source.minTdc?.status).toBe("verified")
    expect(source.report.reportId).toBe("UT-20301107-M1N2")
    const file = await readUtleggSource(MIN_TDC_REPORT, { file: "a.pdf" }, "a.pdf")
    expect(file.minTdc).toBeUndefined()
  })

  test("the recipe takes an Ed25519 public key and rejects anything else", () => {
    const base = JSON.parse(
      JSON.stringify(
        parseConfig(
          {
            checkinAccount: "1960:10001",
            bankAccount: "1920:10001",
            sale: {
              account: "3000",
              lines: [{ description: "x", vatType: "HIGH", from: ["3000"] }],
            },
            purchase: { account: "4300", lines: [] },
            inbox: { reportName: "Regnskapsbilag" },
          },
          "test",
        ),
      ),
    )
    const utlegg = (minTdc: unknown) => ({
      ...base,
      utlegg: {
        inboxName: "expense-report",
        categories: [{ id: "reise", label: "Reise", account: "7140", deduct: false }],
        rules: [],
        minTdc,
      },
    })
    expect(parseConfig(utlegg({ publicKey: TEST_PUBLIC_KEY }), "t").utlegg?.minTdc?.publicKey).toBe(
      TEST_PUBLIC_KEY,
    )
    expect(() => parseConfig(utlegg({ publicKey: "MC4CAQAwBQYDK2VwBCIEIA==" }), "t")).toThrow(
      /Ed25519 public key/,
    )
  })
})
