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
