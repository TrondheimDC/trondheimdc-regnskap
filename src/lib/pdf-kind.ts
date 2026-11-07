// Guesses what a PDF is, so one "open a PDF" entry point (Ad hoc in the web app) can show the
// right review for any document regnskap reads.

import { pdfPages } from "./checkin.ts"
import { looksLikeHotelInvoice } from "./hotel.ts"
import { type PdfInfo, pdfInfo, utleggFormat } from "./utlegg.ts"

type Pages = Awaited<ReturnType<typeof pdfPages>>

export type PdfKind = "hotel" | "utlegg" | "checkin"

/**
 * The hotel's invoice, an utleggsrapport (any format of the form, so a newer one gets a clear
 * "not read yet" instead of the wrong screen) or a Checkin bilag. Checkin is the fallback: its
 * review explains what it couldn't read.
 */
export function pdfKind(pages: Pages, info: PdfInfo = {}): PdfKind {
  if (looksLikeHotelInvoice(pages)) return "hotel"
  if (utleggFormat(pages, info) !== undefined) return "utlegg"
  return "checkin"
}

/** Reads the PDF and guesses its kind. A PDF that can't be read opens as a Checkin bilag. */
export async function detectPdfKind(data: Uint8Array): Promise<PdfKind> {
  const [pages, info] = await Promise.all([pdfPages(data).catch(() => undefined), pdfInfo(data)])
  return pages ? pdfKind(pages, info) : "checkin"
}
