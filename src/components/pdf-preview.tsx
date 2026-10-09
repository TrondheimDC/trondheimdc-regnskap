"use client"

import { ChevronDown, Maximize2, Minimize2 } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { hoverProps, MarkLegend, useMarks } from "@/components/marks"
import { Button } from "@/components/ui/button"
import { MARK_KINDS, type Mark } from "@/lib/marks"
import { type PageImage, type Rect, toPageRect } from "@/lib/pdf-render"
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

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`

/**
 * The summary page with a numbered, colour-coded box over every value the review uses.
 * Collapsible on small screens; on wide screens it sits next to the cards.
 */
export function PdfPreview({
  image,
  marks,
  open,
  onOpenChange,
  className,
}: {
  image: PageImage
  marks: Mark[]
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}) {
  const { active, setActive } = useMarks()
  const [whole, setWhole] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const placed = marks.map((m) => ({ mark: m, rect: markRect(image, m) }))
  const rects = placed.map((p) => p.rect)
  const crop: Rect =
    whole || rects.length === 0
      ? { left: 0, top: 0, right: image.width, bottom: image.height }
      : cropRect(image, rects)
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
          <span className="truncate">Bilaget, side {image.page + 1}</span>
        </button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setWhole(!whole)}
          className={cn("text-[var(--color-fg-base)]/70", !open && "hidden lg:inline-flex")}
        >
          {whole ? (
            <Minimize2 className="size-3.5" aria-hidden />
          ) : (
            <Maximize2 className="size-3.5" aria-hidden />
          )}
          {whole ? "Vis utsnitt" : "Hele siden"}
        </Button>
      </div>

      <div className={cn("flex flex-col gap-3", !open && "hidden lg:flex")}>
        <div ref={scroller} className="overflow-x-auto rounded-lg">
          <div
            className="relative min-w-[36rem] overflow-clip rounded-lg bg-white lg:min-w-0"
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
                alt={`Side ${image.page + 1} av regnskapsbilaget`}
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
