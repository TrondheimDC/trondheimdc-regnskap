"use client"

import { Check, ChevronsUpDown } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface Choice<T extends string | number> {
  value: T
  label: string
  /** Shown under the label and searched, e.g. the account a category books on. */
  hint?: string
}

/**
 * Picks one of a few choices (a category, a VAT rate) in a searchable popover, like AccountPicker.
 * Use this instead of a native <select>: it looks and behaves the same everywhere, including in the
 * dark theme and on phones.
 */
export function ChoicePicker<T extends string | number>({
  label,
  value,
  choices,
  placeholder = "Velg",
  search,
  invalid = false,
  onChange,
  className,
}: {
  /** Accessible name, e.g. "Kategori for kvittering 3". */
  label: string
  value?: T
  choices: Choice<T>[]
  /** Shown when nothing (or something unknown) is picked. */
  placeholder?: string
  /** Show a search field; worth it from about six choices. */
  search?: boolean
  /** Marks the trigger as needing a choice. */
  invalid?: boolean
  onChange: (value: T) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const current = choices.find((c) => c.value === value)
  const searchable = search ?? choices.length > 6
  const pick = (v: T) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          className={cn(
            "max-w-full justify-between gap-2 font-normal",
            (invalid || !current) && "border-[var(--color-bg-danger)]",
            className,
          )}
        >
          <span className={cn("truncate", !current && "text-[var(--color-fg-base)]/60")}>
            {current?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          {searchable ? <CommandInput placeholder="Søk…" /> : null}
          <CommandList>
            <CommandEmpty>Ingen passer.</CommandEmpty>
            <CommandGroup>
              {choices.map((c) => (
                <CommandItem
                  key={String(c.value)}
                  value={`${c.label} ${c.hint ?? ""} ${c.value}`}
                  onSelect={() => pick(c.value)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{c.label}</span>
                    {c.hint ? (
                      <span className="truncate text-xs text-[var(--color-fg-base)]/60">
                        {c.hint}
                      </span>
                    ) : null}
                  </span>
                  <Check
                    className={cn("size-4", c.value === value ? "opacity-100" : "opacity-0")}
                    aria-hidden
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
