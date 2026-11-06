"use client"

import { CircleCheck, FilePen } from "lucide-react"
import type { ReactNode } from "react"
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
import { formatNok } from "@/lib/plan"

export type BookMode = "draft" | "create"

export interface ConfirmItem {
  icon: ReactNode
  label: string
  /** Account, supplier or other detail under the label. */
  detail?: string
  amount: number
}

/** The last stop before writing to Fiken: what will be booked, and what it means. */
export function BookConfirmDialog({
  mode,
  title,
  subtitle,
  items,
  notes,
  onCancel,
  onConfirm,
}: {
  mode?: BookMode
  title: { draft: string; create: string }
  /** E.g. "September 2026 · Trondheimdc". */
  subtitle: string
  items: ConfirmItem[]
  /** Short consequences, shown under the list. */
  notes: (string | false | undefined)[]
  onCancel: () => void
  onConfirm: (mode: BookMode) => void
}) {
  const draft = mode === "draft"
  const shown = notes.filter((n): n is string => Boolean(n))
  return (
    <AlertDialog open={mode !== undefined} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{draft ? title.draft : title.create}</AlertDialogTitle>
          <AlertDialogDescription>{subtitle}</AlertDialogDescription>
        </AlertDialogHeader>

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

        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction onClick={() => mode && onConfirm(mode)}>
            {draft ? (
              <FilePen className="size-5" aria-hidden />
            ) : (
              <CircleCheck className="size-5" aria-hidden />
            )}
            {draft ? "Lag utkast" : "Bokfør"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
