"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { MARK_KINDS, type Mark } from "@/lib/marks"
import { formatNok } from "@/lib/plan"
import { cn } from "@/lib/utils"

interface MarkState {
  byKey: Map<string, Mark>
  /** Marks emphasised right now (hovered or focused, in the cards or on the PDF). */
  active: number[]
  setActive: (marks: number[]) => void
  /** Brings a mark on the PDF into view (opening the PDF section on small screens). */
  reveal: (n: number) => void
}

const MarkContext = createContext<MarkState | undefined>(undefined)

export function MarkProvider({
  marks,
  onReveal,
  children,
}: {
  marks: Mark[]
  onReveal: () => void
  children: ReactNode
}) {
  const [hovered, setActive] = useState<number[]>([])
  // A revealed mark stays emphasised for a moment, even if scrolling moves it out from under the
  // pointer.
  const [pinned, setPinned] = useState<number>()
  const unpin = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(unpin.current), [])
  const byKey = useMemo(() => new Map(marks.map((m) => [m.key, m])), [marks])
  const reveal = useCallback(
    (n: number) => {
      onReveal()
      setPinned(n)
      clearTimeout(unpin.current)
      unpin.current = setTimeout(() => setPinned(undefined), 2500)
      // Wait a frame so a just-opened PDF section has its layout. The crop box is overflow: clip,
      // not hidden, so this can't scroll it sideways where the user can't scroll back.
      requestAnimationFrame(() =>
        document
          .getElementById(`mark-${n}`)
          ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }),
      )
    },
    [onReveal],
  )
  const value = useMemo(
    () => ({
      byKey,
      active: hovered.length > 0 ? hovered : pinned === undefined ? [] : [pinned],
      setActive,
      reveal,
    }),
    [byKey, hovered, pinned, reveal],
  )
  return <MarkContext.Provider value={value}>{children}</MarkContext.Provider>
}

/**
 * Pointer props that emphasise `marks` while a mouse or pen hovers. Touch is left out: it fires
 * pointerleave right after a tap, which would undo the tap's emphasis.
 */
export function hoverProps(setActive: (marks: number[]) => void, marks: number[]) {
  if (marks.length === 0) return {}
  return {
    onPointerEnter: (e: React.PointerEvent) => e.pointerType !== "touch" && setActive(marks),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType !== "touch" && setActive([]),
  }
}

export function useMarks() {
  const state = useContext(MarkContext)
  if (!state) throw new Error("useMarks outside MarkProvider")
  return state
}

/** Marks for the given box keys, skipping keys the PDF didn't have. */
export function useMarksFor(keys: (string | undefined)[]): Mark[] {
  const { byKey } = useMarks()
  return keys.flatMap((k) => (k && byKey.get(k)) || [])
}

/** Round number badge in the mark's colour; hover/focus emphasises the highlight on the PDF. */
export function MarkBadge({ mark, className }: { mark: Mark; className?: string }) {
  const { active, setActive, reveal } = useMarks()
  const on = active.includes(mark.n)
  return (
    <button
      type="button"
      aria-label={`Vis ${mark.n} i bilaget: ${mark.label}, ${formatNok(mark.amount)}`}
      title={`${mark.label}: ${formatNok(mark.amount)} i bilaget`}
      {...hoverProps(setActive, [mark.n])}
      onFocus={() => setActive([mark.n])}
      onBlur={() => setActive([])}
      onClick={() => reveal(mark.n)}
      style={{ "--mark": MARK_KINDS[mark.kind].color } as React.CSSProperties}
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--mark)] px-1 align-middle font-sans text-[11px] leading-none font-bold text-[var(--color-fg-always-dark)] tabular-nums transition-[transform,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mark)]",
        on && "scale-115 shadow-[0_0_0_3px_color-mix(in_srgb,var(--mark)_35%,transparent)]",
        className,
      )}
    >
      {mark.n}
    </button>
  )
}

/** Badges for several marks, e.g. a line made up of two Checkin accounts. */
export function MarkBadges({ marks }: { marks: Mark[] }) {
  if (marks.length === 0) return null
  return (
    <span className="inline-flex gap-1">
      {marks.map((m) => (
        <MarkBadge key={m.n} mark={m} />
      ))}
    </span>
  )
}

/** A row that emphasises its marks on the PDF while hovered. */
export function MarkRow({
  marks,
  className,
  children,
}: {
  marks: Mark[]
  className?: string
  children: ReactNode
}) {
  const { active, setActive } = useMarks()
  const on = marks.length > 0 && marks.some((m) => active.includes(m.n))
  return (
    <li
      {...hoverProps(
        setActive,
        marks.map((m) => m.n),
      )}
      className={cn(
        "-mx-2 rounded-lg px-2 py-1.5 transition-colors duration-150",
        on && "bg-white/[0.06]",
        className,
      )}
    >
      {children}
    </li>
  )
}

export function MarkLegend({ marks }: { marks: Mark[] }) {
  const kinds = (Object.keys(MARK_KINDS) as Mark["kind"][]).filter((k) =>
    marks.some((m) => m.kind === k),
  )
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--color-fg-base)]/70">
      {kinds.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ background: MARK_KINDS[k].color }}
          />
          {MARK_KINDS[k].label}
        </li>
      ))}
    </ul>
  )
}

/**
 * An amount with its mark badges after it. The badge column is reserved even without marks, so
 * amounts in a list line up.
 */
export function MarkedAmount({
  marks,
  className,
  children,
}: {
  marks: Mark[]
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cn("flex items-center justify-end gap-2", className)}>
      <span className="tabular">{children}</span>
      {marks.length > 0 ? <MarkBadges marks={marks} /> : <span aria-hidden className="w-5" />}
    </span>
  )
}
