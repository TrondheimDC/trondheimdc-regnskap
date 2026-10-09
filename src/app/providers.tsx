"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { AppLoading } from "@/components/app-loading"
import { Toaster } from "@/components/ui/sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Fiken allows one request at a time; don't refetch behind the user's back.
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  )
  // The session lives in sessionStorage, so the real first screen is only known after mount.
  const [booted, setBooted] = useState(false)
  useEffect(() => setBooted(true), [])

  return (
    <QueryClientProvider client={queryClient}>
      {booted ? children : <AppLoading />}
      <Toaster />
    </QueryClientProvider>
  )
}
