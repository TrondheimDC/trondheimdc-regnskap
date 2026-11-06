import type { ReactNode } from "react"
import { TAccount, TAccountBadge } from "@/components/tdc-regnskap-logo"
import { cn } from "@/lib/utils"

type ArtProps = { className?: string }

const ink = "var(--color-bg-base, #0f0f0f)"
const danger = "var(--color-bg-danger, #f1422a)"

/** Frame around the logo's T-account (1024 units), same footprint as innsjekk's scenes. */
function Scene({ label, className, children }: ArtProps & { label: string; children: ReactNode }) {
  return (
    <svg
      viewBox="90 200 900 720"
      className={cn("h-auto w-full text-[var(--color-fg-brand)]", className)}
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  )
}

/** 404: an empty T-account with a question mark. */
export function TAccountNotFoundIllustration({ className }: ArtProps) {
  return (
    <Scene label="Tom T-konto med spørsmålstegn" className={className}>
      <TAccount entries={false} sums={false} />
      <TAccountBadge>
        <path
          stroke={ink}
          strokeWidth="30"
          strokeLinecap="square"
          fill="none"
          d="M816 770v-26h70v50h-36v22"
        />
        <path fill={ink} d="M835 846h30v30h-30Z" />
      </TAccountBadge>
    </Scene>
  )
}

/** Crash: the T-account with a red exclamation badge. */
export function TAccountErrorIllustration({ className }: ArtProps) {
  return (
    <Scene label="T-konto med rødt utropstegn" className={className}>
      <TAccount />
      <TAccountBadge fill={danger}>
        <path fill="var(--color-white-1, #fefefe)" d="M835 730h30v84h-30ZM835 834h30v30h-30Z" />
      </TAccountBadge>
    </Scene>
  )
}

// The logo's entries and sums as separate boxes, so they can be posted one by one.
const entryBoxes = [
  { x: 242, y: 432, w: 170 },
  { x: 682, y: 432, w: 150 },
  { x: 292, y: 512, w: 120 },
  { x: 612, y: 512, w: 220 },
]
const sumBoxes = [
  { x: 252, y: 706, w: 160 },
  { x: 672, y: 706, w: 160 },
]

/** All booked: the entries are posted line by line, the sums balance and a check lands. */
export function TAccountBookedIllustration({ className }: ArtProps) {
  return (
    <Scene label="T-konto som går i balanse, med hake" className={className}>
      <TAccount entries={false} sums={false} />
      <g fill="currentColor">
        {entryBoxes.map((b, i) => (
          <rect
            key={`${b.x}-${b.y}`}
            x={b.x}
            y={b.y}
            width={b.w}
            height="48"
            className="ta-post"
            style={{ animationDelay: `${0.25 + i * 0.18}s` }}
          />
        ))}
        {sumBoxes.map((b, i) => (
          <rect
            key={b.x}
            x={b.x}
            y={b.y}
            width={b.w}
            height="48"
            className="ta-sum"
            style={{ animationDelay: `${1.05 + i * 0.12}s` }}
          />
        ))}
      </g>
      <circle
        cx="850"
        cy="800"
        r="100"
        fill="none"
        stroke="currentColor"
        strokeWidth="10"
        className="ta-ring"
      />
      <g className="ta-pop">
        <TAccountBadge fill="currentColor">
          <path
            d="M798 802l34 34 70-72"
            fill="none"
            stroke={ink}
            strokeWidth="30"
            strokeLinecap="square"
            className="ta-check"
          />
        </TAccountBadge>
      </g>
    </Scene>
  )
}

/** Nothing received yet: empty slots in the account, and the badge waits with three dots. */
export function TAccountWaitingIllustration({ className }: ArtProps) {
  return (
    <Scene label="Tom T-konto som venter på bilag" className={className}>
      <TAccount entries={false} sums={false} />
      <g fill="none" stroke="currentColor" strokeWidth="6" strokeDasharray="18 12">
        {[...entryBoxes, ...sumBoxes].map((b, i) => (
          <rect
            key={`${b.x}-${b.y}`}
            x={b.x + 3}
            y={b.y + 3}
            width={b.w - 6}
            height="42"
            className="ta-slot"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </g>
      <TAccountBadge>
        {[805, 850, 895].map((cx, i) => (
          <circle
            key={cx}
            cx={cx}
            cy="806"
            r="15"
            fill={ink}
            className="ta-dot"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </TAccountBadge>
    </Scene>
  )
}

/** Ad hoc: an empty account, and the badge lifts a PDF in. */
export function TAccountUploadIllustration({ className }: ArtProps) {
  return (
    <Scene label="Tom T-konto med opplastingspil" className={className}>
      <TAccount entries={false} sums={false} />
      <g fill="none" stroke="currentColor" strokeWidth="6" strokeDasharray="18 12">
        {[...entryBoxes, ...sumBoxes].map((b) => (
          <rect
            key={`${b.x}-${b.y}`}
            x={b.x + 3}
            y={b.y + 3}
            width={b.w - 6}
            height="42"
            opacity="0.25"
          />
        ))}
      </g>
      <TAccountBadge fill="currentColor">
        <g className="ta-lift">
          <path
            d="M850 856v-104M806 790l44-44 44 44"
            fill="none"
            stroke={ink}
            strokeWidth="30"
            strokeLinecap="square"
          />
        </g>
      </TAccountBadge>
    </Scene>
  )
}
