import { cn } from "@/lib/utils"

/** TDC wordmark from trondheimdc.no (green letterforms). */
export function TdcLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[1.625rem] items-center gap-[0.2275rem]", className)}
      role="img"
      aria-label="TDC"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 40 52"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-auto"
      >
        <path
          d="M10.0986 17.333H0L0 0L39.8145 0V17.333H29.7178V52H10.0986V17.333Z"
          fill="var(--color-fg-brand)"
        />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 154 52"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-auto"
      >
        <path
          d="M153.732 34.667C153.732 44.2406 145.983 52 136.422 52H0L0 0L136.422 0C145.983 0 153.732 7.75938 153.732 17.333V34.667Z"
          fill="var(--color-fg-brand)"
        />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 40 52"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-auto"
      >
        <path
          d="M39.8145 17.333H19.9072V34.667H39.8145V52H17.3105C7.74943 52 0.000113284 44.2407 0 34.667L0 17.333C0.000185034 7.75938 7.74948 0 17.3105 0L39.8145 0V17.333Z"
          fill="var(--color-fg-brand)"
        />
      </svg>
    </span>
  )
}
