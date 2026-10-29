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
  CommandSeparator,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { groupAccounts } from "@/lib/accounts"
import type { Account } from "@/lib/fiken"
import { cn } from "@/lib/utils"

/**
 * Picks an account from Fiken's chart of accounts: type a number or a name, grouped by account
 * class, with the recipe's account on top.
 */
export function AccountPicker({
  id,
  value,
  suggested,
  accounts,
  onChange,
}: {
  id: string
  value: string
  /** The recipe's account for this category. */
  suggested?: string
  accounts: Account[]
  onChange: (account: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = accounts.find((a) => a.code === value)
  const recipe = accounts.find((a) => a.code === suggested)
  const pick = (code: string) => {
    onChange(code)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full max-w-[20rem] justify-between font-normal sm:w-[20rem]",
            !current && "border-[var(--color-bg-danger)]",
          )}
        >
          <span className="truncate">
            <span className="tabular font-semibold">{value}</span>{" "}
            <span className={cn(!current && "text-[var(--color-bg-danger)]")}>
              {current?.name ?? "finnes ikke i Fiken"}
            </span>
          </span>
          <ChevronsUpDown className="size-4 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
        <Command filter={matchAccount}>
          <CommandInput placeholder="Søk på nummer eller navn…" />
          <CommandList>
            <CommandEmpty>Ingen konto passer.</CommandEmpty>
            {recipe ? (
              <>
                <CommandGroup heading="Foreslått i oppskriften">
                  <AccountItem account={recipe} selected={value} value="foreslått" onPick={pick} />
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {groupAccounts(accounts).map((g) => (
              <CommandGroup key={g.klass} heading={g.label}>
                {g.accounts.map((a) => (
                  <AccountItem key={a.code} account={a} selected={value} onPick={pick} />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Digits match the start of the account number ("43" → 4300); text matches the name. */
function matchAccount(_value: string, search: string, keywords: string[] = []) {
  const query = search.trim().toLowerCase()
  const [code = "", name = ""] = keywords
  if (!query) return 1
  if (/^\d+$/.test(query)) return code.startsWith(query) ? 1 : 0
  return `${code} ${name}`.toLowerCase().includes(query) ? 1 : 0
}

function AccountItem({
  account,
  selected,
  value = "",
  onPick,
}: {
  account: Account
  selected: string
  /** Prefix that keeps the item unique when the same account shows in two groups. */
  value?: string
  onPick: (code: string) => void
}) {
  return (
    <CommandItem
      value={`${value} ${account.code} ${account.name ?? ""}`.trim()}
      keywords={[account.code, account.name ?? ""]}
      onSelect={() => onPick(account.code)}
    >
      <span className="tabular w-12 shrink-0 font-semibold">{account.code}</span>
      <span className="min-w-0 flex-1 truncate">{account.name}</span>
      <Check
        className={cn("size-4", account.code === selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
    </CommandItem>
  )
}
