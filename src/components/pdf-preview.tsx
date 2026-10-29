"use client"

import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { hoverProps, MarkLegend, useMarks } from "@/components/marks"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { MARK_KINDS, type Mark } from "@/lib/marks"
import { type PageImage, type Rect, renderPdfPage, toPageRect } from "@/lib/pdf-render"
import { formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"

/** Space around a value's glyphs, in PDF units. */
const PAD = 1.5

function markRect(image: PageImage, { box }: Mark): Rect {
  // Box y is the baseline; digits rise about 0.75 × font size and minus signs/commas dip a bit.
  return toPageRect(image.transform, {
    x0: box.x0 - PAD,
    x1: box.x1 + PAD,
    y0: box.y - box.h * 0.22 - PAD,
    y1: box.y + box.h * 0.82 + PAD,
  })
}

/** The part of the page with the tables: all text across, from the top down to below the last mark. */
function cropRect(image: PageImage, rects: Rect[]): Rect {
  const { content } = image
  const lowest = Math.max(...rects.map((r) => r.bottom))
  return {
    left: Math.max(0, content.left - 16),
    right: Math.min(image.width, content.right + 16),
    top: Math.max(0, content.top - 16),
    bottom: Math.min(image.height, content.bottom + 16, lowest + 40),
  }
}

/** The text on the page with a little margin. */
function textRect(image: PageImage): Rect {
  const { content } = image
  return {
    left: Math.max(0, content.left - 16),
    right: Math.min(image.width, content.right + 16),
    top: Math.max(0, content.top - 16),
    bottom: Math.min(image.height, content.bottom + 16),
  }
}

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`

/**
 * The summary page with a numbered, colour-coded box over every value the review uses.
 * Collapsible on small screens; on wide screens it sits next to the cards.
 */
/** Paging through the PDF: the page shown (0-based), how many there are, and loading state. */
interface Pager {
  page: number
  count: number
  onPage: (page: number) => void
  /** The page asked for is still being rendered; the previous one stays in its place. */
  loading?: boolean
}

export function PdfPreview({
  image,
  marks,
  open,
  onOpenChange,
  title = "Bilaget",
  pager,
  className,
}: {
  image: PageImage
  marks: Mark[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the document is, e.g. "Fakturaen". */
  title?: string
  pager?: Pager
  className?: string
}) {
  const { active, setActive } = useMarks()
  const [whole, setWhole] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const placed = marks.map((m) => ({ mark: m, rect: markRect(image, m) }))
  const rects = placed.map((p) => p.rect)
  // With marks: down to below the last one. Without: the text on the page, without the margins.
  const crop: Rect = whole
    ? { left: 0, top: 0, right: image.width, bottom: image.height }
    : rects.length > 0
      ? cropRect(image, rects)
      : textRect(image)
  const cw = crop.right - crop.left
  const ch = crop.bottom - crop.top

  // On narrow screens the page is wider than the viewport; start at the amounts on the right.
  useEffect(() => {
    const el = scroller.current
    if (open && el) el.scrollLeft = el.scrollWidth
  }, [open])

  return (
    <section
      aria-label="Bilaget med markeringer"
      className={cn("flex flex-col gap-3 rounded-xl bg-[var(--color-bg-surface)] p-3", className)}
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 cursor-pointer items-center gap-2 text-left text-sm font-semibold lg:pointer-events-none"
        >
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 transition-transform lg:hidden", !open && "-rotate-90")}
          />
          <span className="truncate">
            {title}, side {(pager?.page ?? image.page) + 1}
            {pager && pager.count > 1 ? ` av ${pager.count}` : ""}
          </span>
          {pager?.loading ? <Spinner className="size-3.5 shrink-0" /> : null}
        </button>
        <div className={cn("flex items-center gap-1", !open && "hidden lg:flex")}>
          {/* A page without marks is always shown whole. */}
          {rects.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setWhole(!whole)}
              className="text-[var(--color-fg-base)]/70"
            >
              {whole ? (
                <Minimize2 className="size-3.5" aria-hidden />
              ) : (
                <Maximize2 className="size-3.5" aria-hidden />
              )}
              {whole ? "Vis utsnitt" : "Hele siden"}
            </Button>
          ) : null}
          {pager && pager.count > 1 ? (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Forrige side"
                disabled={pager.page === 0}
                onClick={() => pager.onPage(pager.page - 1)}
                className="text-[var(--color-fg-base)]/70"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Neste side"
                disabled={pager.page === pager.count - 1}
                onClick={() => pager.onPage(pager.page + 1)}
                className="text-[var(--color-fg-base)]/70"
              >
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className={cn("flex flex-col gap-3", !open && "hidden lg:flex")}>
        <div ref={scroller} className="overflow-x-auto rounded-lg">
          <div
            className={cn(
              "relative min-w-[36rem] overflow-clip rounded-lg bg-white transition-opacity lg:min-w-0",
              pager?.loading && "opacity-60",
            )}
            style={{ aspectRatio: `${cw} / ${ch}` }}
          >
            <div
              className="absolute [container-type:inline-size]"
              style={{
                left: pct(-crop.left, cw),
                top: pct(-crop.top, ch),
                width: pct(image.width, cw),
                height: pct(image.height, ch),
              }}
            >
              <img
                src={image.url}
                alt={`${title}, side ${image.page + 1}`}
                className="absolute inset-0 size-full select-none"
                draggable={false}
              />
              {placed.map(({ mark: m, rect: r }) => {
                const on = active.includes(m.n)
                return (
                  <div
                    key={m.n}
                    id={`mark-${m.n}`}
                    role="img"
                    aria-label={`${m.n}: ${m.label}, ${formatNok(m.amount)}`}
                    {...hoverProps(setActive, [m.n])}
                    className={cn(
                      "pdf-mark absolute rounded-[0.35cqw] transition-[background-color,box-shadow] duration-150",
                      on && "pdf-mark-on",
                      active.length > 0 && !on && "opacity-60",
                    )}
                    style={
                      {
                        "--mark": MARK_KINDS[m.kind].color,
                        left: pct(r.left, image.width),
                        top: pct(r.top, image.height),
                        width: pct(r.right - r.left, image.width),
                        height: pct(r.bottom - r.top, image.height),
                      } as CSSProperties
                    }
                  >
                    <span className="pdf-mark-n absolute top-1/2 right-full mr-[0.4cqw] -translate-y-1/2">
                      {m.n}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-1 pb-1">
          <MarkLegend marks={marks} />
          <p className="text-xs text-[var(--color-fg-base)]/50 lg:hidden">
            Dra sidelengs for å se kontonavnene.
          </p>
        </div>
      </div>
    </section>
  )
}

// Each PDF gets a number for the page cache, so pages from two documents never mix.
const pdfIds = new WeakMap<Uint8Array, number>()
let lastPdfId = 0
const pdfId = (pdf: Uint8Array) => {
  if (!pdfIds.has(pdf)) pdfIds.set(pdf, ++lastPdfId)
  return pdfIds.get(pdf)
}

/**
 * The PDF with paging. `first` is rendered up front so the review opens on it; other pages are
 * rendered when the user turns to them, and the previous page stays in place meanwhile.
 */
export function PagedPdfPreview({
  pdf,
  first,
  count,
  page,
  onPage,
  marks,
  ...props
}: {
  pdf: Uint8Array
  first: PageImage
  count: number
  page: number
  onPage: (page: number) => void
  /** Marks on every page; each page shows its own. */
  marks: Mark[]
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  className?: string
}) {
  const rendered = useQuery({
    queryKey: ["pdf-page", pdfId(pdf), page],
    queryFn: () => (page === first.page ? first : renderPdfPage(pdf, page)),
    initialData: page === first.page ? first : undefined,
    placeholderData: (previous) => previous,
  })
  const image = rendered.data ?? first
  return (
    <PdfPreview
      {...props}
      image={image}
      marks={marks.filter((m) => m.box.page === image.page)}
      pager={{ page, count, onPage, loading: image.page !== page }}
    />
  )
}
