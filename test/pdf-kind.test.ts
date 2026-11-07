import { describe, expect, test } from "vitest"
import { detectPdfKind } from "../src/lib/pdf-kind.ts"
import {
  HOTEL_INVOICE,
  MARCH_2026,
  UTLEGG_REPORT,
  UTLEGG_REPORT_V2,
  utleggPdf,
} from "./pdf-fixture.ts"

describe("detectPdfKind", () => {
  test("knows every document regnskap reads", async () => {
    expect(await detectPdfKind(MARCH_2026)).toBe("checkin")
    expect(await detectPdfKind(HOTEL_INVOICE)).toBe("hotel")
    expect(await detectPdfKind(UTLEGG_REPORT)).toBe("utlegg")
    expect(await detectPdfKind(UTLEGG_REPORT_V2)).toBe("utlegg")
  })

  test("a newer utlegg format still opens as utlegg, which says it can't read it yet", async () => {
    const v3 = utleggPdf({
      name: "Kari Testesen",
      email: "kari@example.com",
      account: "1234 56 78903",
      generated: "06.11.2030",
      receipts: [{ description: "Taxi", date: "01.10.2030", amount: 1000 }],
      info: { Subject: "TrondheimDC utleggsrapport, format 3", Keywords: "format-3" },
    })
    expect(await detectPdfKind(v3)).toBe("utlegg")
  })

  test("something that isn't a PDF falls back to Checkin, which explains", async () => {
    expect(await detectPdfKind(new TextEncoder().encode("not a pdf"))).toBe("checkin")
  })
})
