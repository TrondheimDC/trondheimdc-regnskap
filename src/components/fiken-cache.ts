import type { QueryClient } from "@tanstack/react-query"

/** Queries that read the bilag and Fiken for one review screen. */
const ANALYSES = new Set<unknown>(["analysis", "hotel-analysis"])
/** Lists on the start page, read from Fiken. */
const LISTS = new Set<unknown>(["inbox", "hotel-invoices"])

/**
 * After any write to Fiken, also a failed one that got partway: every cached Fiken read may be
 * out of date, also for other months (balances) and the other recipe (inbox, used documents).
 * The open review keeps showing the booking result; analyses are read again when next opened.
 */
export async function invalidateFikenReads(queryClient: QueryClient) {
  await queryClient.invalidateQueries({
    predicate: (q) => ANALYSES.has(q.queryKey[0]),
    refetchType: "none",
  })
  await queryClient.invalidateQueries({ predicate: (q) => LISTS.has(q.queryKey[0]) })
}
