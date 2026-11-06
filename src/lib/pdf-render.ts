// Renders one PDF page to an image in the browser, so values read from it can be highlighted.

import { getDocumentProxy } from "unpdf"

/** Maps PDF user space (origin bottom-left) to page pixels at scale 1 (origin top-left). */
export type PageTransform = [number, number, number, number, number, number]

export interface PageImage {
  /** 0-based page index. */
  page: number
  /** PNG data URL. */
  url: string
  /** Page size in CSS pixels at scale 1 (= PDF units for unrotated pages). */
  width: number
  height: number
  transform: PageTransform
  /** Bounding box of what is drawn on the page (text, images, lines), in page pixels at scale 1. */
  content: Rect
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** PDF-space rectangle -> page-pixel rectangle. */
export function toPageRect(
  t: PageTransform,
  { x0, x1, y0, y1 }: { x0: number; x1: number; y0: number; y1: number },
): Rect {
  const point = (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]
  const [ax, ay] = point(x0, y0) as [number, number]
  const [bx, by] = point(x1, y1) as [number, number]
  return {
    left: Math.min(ax, bx),
    right: Math.max(ax, bx),
    top: Math.min(ay, by),
    bottom: Math.max(ay, by),
  }
}

/** Number of pages in the PDF. */
export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(data.slice())
  try {
    return pdf.numPages
  } finally {
    await pdf.loadingTask.destroy()
  }
}

/**
 * Renders `page` (0-based) at `scale` device pixels per PDF unit. pdf.js detaches the buffer it
 * gets, so it is given a copy and `data` stays usable.
 */
export async function renderPdfPage(data: Uint8Array, page: number, scale = 3): Promise<PageImage> {
  const pdf = await getDocumentProxy(data.slice())
  try {
    const pdfPage = await pdf.getPage(page + 1)
    const base = pdfPage.getViewport({ scale: 1 })
    const viewport = pdfPage.getViewport({ scale })
    const canvas = document.createElement("canvas")
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await pdfPage.render({ canvas, viewport }).promise

    const transform = base.transform as PageTransform
    const content: Rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    for (const item of (await pdfPage.getTextContent()).items) {
      if (!("str" in item) || item.str.trim() === "") continue
      const x = item.transform[4] as number
      const y = item.transform[5] as number
      const r = toPageRect(transform, { x0: x, x1: x + item.width, y0: y, y1: y + item.height })
      content.left = Math.min(content.left, r.left)
      content.top = Math.min(content.top, r.top)
      content.right = Math.max(content.right, r.right)
      content.bottom = Math.max(content.bottom, r.bottom)
    }
    // Text alone misses a photo or a scanned receipt, leaving only its header in view.
    const ink = inkBounds(canvas, base.width / canvas.width)
    if (ink) {
      content.left = Math.min(content.left, ink.left)
      content.top = Math.min(content.top, ink.top)
      content.right = Math.max(content.right, ink.right)
      content.bottom = Math.max(content.bottom, ink.bottom)
    }
    if (!Number.isFinite(content.left))
      Object.assign(content, { left: 0, top: 0, right: base.width, bottom: base.height })

    return {
      page,
      url: canvas.toDataURL("image/png"),
      width: base.width,
      height: base.height,
      transform,
      content,
    }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

/** Width the page is scanned at for drawn content: enough to find the edges within a few points. */
const INK_SCAN_WIDTH = 200

/**
 * The box around everything that isn't white paper on the rendered page, in page pixels at scale 1
 * (`unit` is page pixels per canvas pixel). Scans a small copy, so it costs a few milliseconds.
 */
function inkBounds(canvas: HTMLCanvasElement, unit: number): Rect | undefined {
  const w = INK_SCAN_WIDTH
  const h = Math.max(1, Math.round((canvas.height / canvas.width) * w))
  const small = document.createElement("canvas")
  small.width = w
  small.height = h
  const ctx = small.getContext("2d", { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(canvas, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  let left = w
  let top = h
  let right = -1
  let bottom = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // Off-white counts as paper, so faint scan noise and anti-aliasing don't widen the box.
      if (data[i]! > 235 && data[i + 1]! > 235 && data[i + 2]! > 235) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  if (right < 0) return undefined
  const scale = (canvas.width / w) * unit
  return {
    left: left * scale,
    top: top * scale,
    right: (right + 1) * scale,
    bottom: (bottom + 1) * scale,
  }
}
