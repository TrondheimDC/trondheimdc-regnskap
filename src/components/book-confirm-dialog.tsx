"use client"

import { CircleCheck, CircleX, FilePen, OctagonX } from "lucide-react"
import type { ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatNok } from "@/lib/plan"

export type BookMode = "draft" | "create"

export interface ConfirmItem {
  icon: ReactNode
  label: string
  /** Account, supplier or other detail under the label. */
  detail?: string
  amount: number
}

/** A booking under way or done, shown in place of the plan. */
export interface BookRun {
  /** Steps done in Fiken, in order. */
  progress: string[]
  pending: boolean
  error: Error | null
  /** Rows after the steps once done, e.g. the balance against what it should be. */
  result?: ReactNode
  /** Under the steps once done, e.g. a reminder about drafts. */
  footnote?: ReactNode
}

/**
 * The last stop before writing to Fiken, and where the writing happens: first what will be
 * booked, then each step as Fiken takes it. It can't be closed while Fiken is being written to.
 */
export function BookConfirmDialog({
  mode,
  title,
  done = { draft: "Utkastet ligger i Fiken", create: "Bokført i Fiken" },
  subtitle,
  items,
  notes,
  run,
  onCancel,
  onConfirm,
}: {
  mode?: BookMode
  title: { draft: string; create: string }
  /** Title once booked, per mode. */
  done?: { draft: string; create: string }
  /** E.g. "September 2026 · Trondheimdc". */
  subtitle: string
  items: ConfirmItem[]
  /** Short consequences, shown under the list. */
  notes: (string | false | undefined)[]
  /**
   * Set from the moment the user confirms, to book inside the dialog. Without it the caller
   * closes the dialog in `onConfirm` and shows the booking elsewhere.
   */
  run?: BookRun
  /** Closes the dialog: Avbryt before booking, Ferdig after. */
  onCancel: () => void
  onConfirm: (mode: BookMode) => void
}) {
  const draft = mode === "draft"
  const shown = notes.filter((n): n is string => Boolean(n))
  const busy = run?.pending ?? false
  const heading = !run
    ? draft
      ? title.draft
      : title.create
    : run.pending
      ? "Fører i Fiken…"
      : run.error
        ? "Føringen stoppet"
        : draft
          ? done.draft
          : done.create
  return (
    <AlertDialog open={mode !== undefined} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent onEscapeKeyDown={(e) => busy && e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{heading}</AlertDialogTitle>
          <AlertDialogDescription>{subtitle}</AlertDialogDescription>
        </AlertDialogHeader>

        {run ? (
          <RunSteps run={run} />
        ) : (
          <>
            <ul className="divide-y divide-white/10 rounded-lg bg-white/5 px-3">
              {items.map((item) => (
                <li key={item.label} className="flex items-center gap-3 py-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg-brand)]/15 text-[var(--color-fg-brand)] [&_svg]:size-4">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{item.label}</span>
                    {item.detail ? (
                      <span className="block text-xs text-[var(--color-fg-base)]/60">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                  <span className="tabular shrink-0">{formatNok(item.amount)}</span>
                </li>
              ))}
            </ul>

            {shown.length > 0 ? (
              <ul className="space-y-1.5 text-sm text-[var(--color-fg-base)]/70">
                {shown.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        {run ? (
          busy ? null : (
            <Button onClick={onCancel} className="w-full">
              Ferdig
            </Button>
          )
        ) : (
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Stay open: the booking runs in here.
                e.preventDefault()
                if (mode) onConfirm(mode)
              }}
            >
              {draft ? (
                <FilePen className="size-5" aria-hidden />
              ) : (
                <CircleCheck className="size-5" aria-hidden />
              )}
              {draft ? "Lag utkast" : "Bokfør"}
            </AlertDialogAction>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RunSteps({ run }: { run: BookRun }) {
  return (
    <>
      <ul className="space-y-3 rounded-lg bg-white/5 p-3">
        {run.progress.map((s) => (
          <StepRow key={s} ok>
            {s}
          </StepRow>
        ))}
        {run.pending ? (
          <li className="flex items-center gap-3 text-[var(--color-fg-base)]/70">
            <Spinner className="size-5" />
            Ikke lukk siden før føringen er ferdig
          </li>
        ) : (
          run.result
        )}
      </ul>

      {run.error ? (
        <Alert variant="destructive">
          <OctagonX aria-hidden />
          <AlertTitle>Fiken avviste et steg</AlertTitle>
          <AlertDescription>
            <p className="select-text break-all font-mono text-xs">{run.error.message}</p>
            <p>Det som er merket ✓ ligger i Fiken. Resten må du føre eller rydde opp i Fiken.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {!run.pending ? run.footnote : null}
    </>
  )
}

/** One line in the booking's steps: done, or off from what it should be. */
export function StepRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      {ok ? (
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-[var(--color-fg-brand)]" aria-hidden />
      ) : (
        <CircleX className="mt-0.5 size-5 shrink-0 text-[var(--color-bg-danger)]" aria-hidden />
      )}
      <span>{children}</span>
    </li>
  )
}
