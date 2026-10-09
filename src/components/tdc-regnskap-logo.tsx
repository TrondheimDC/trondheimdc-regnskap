import type { ReactNode } from "react"

const cutoutColor = "var(--color-bg-base, #0f0f0f)"
const paperColor = "var(--color-white-1, #fefefe)"

/**
 * The T-account (T-konto) from the app icon, in its 1024 × 1024 units: the TDC "T" is the
 * account header and the debet | kredit divider. Badge centre: (850, 800).
 */
export function TAccount({
  entries = true,
  sums = true,
  cutout = cutoutColor,
}: {
  /** Draw the entries in each column; off for an empty account. */
  entries?: boolean
  /** Draw the (equal) sums under the double rule. */
  sums?: boolean
  cutout?: string
}) {
  return (
    <>
      <g fill="currentColor">
        <path d="M152 222h720v150H572v430H452V372H152Z" />
        {entries ? (
          <path d="M242 432h170v48H242ZM292 512h120v48H292ZM682 432h150v48H682ZM612 512h220v48H612Z" />
        ) : null}
        <path d="M212 616h200v18H212ZM212 652h200v18H212ZM632 616h200v18H632ZM632 652h200v18H632Z" />
        {sums ? <path d="M252 706h160v48H252ZM672 706h160v48H672Z" /> : null}
      </g>
      {/* TDC as the account name */}
      <g fill={cutout} transform="translate(313.6 255.5) scale(1.6)">
        <path d="M10.0986 17.333H0L0 0L39.8145 0V17.333H29.7178V52H10.0986V17.333Z" />
        <path
          transform="translate(47.09 0)"
          d="M153.732 34.667C153.732 44.2406 145.983 52 136.422 52H0L0 0L136.422 0C145.983 0 153.732 7.75938 153.732 17.333V34.667Z"
        />
        <path
          transform="translate(208.1 0)"
          d="M39.8145 17.333H19.9072V34.667H39.8145V52H17.3105C7.74943 52 0.000113284 44.2407 0 34.667L0 17.333C0.000185034 7.75938 7.74948 0 17.3105 0L39.8145 0V17.333Z"
        />
      </g>
    </>
  )
}

/** Round badge over the account's bottom-right corner, with a cut-out ring. */
export function TAccountBadge({
  fill = paperColor,
  cutout = cutoutColor,
  children,
}: {
  fill?: string
  cutout?: string
  children: ReactNode
}) {
  return (
    <>
      <circle cx="850" cy="800" r="128" fill={cutout} />
      <circle cx="850" cy="800" r="100" fill={fill} />
      {children}
    </>
  )
}

/** TDC T-account mark for Regnskap (same drawing as the app icon, src/app/icon.svg). */
export function TdcRegnskapLogo({
  className,
  title = "TDC Regnskap",
}: {
  className?: string
  title?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <TAccount />
    </svg>
  )
}
