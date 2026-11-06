"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { AppLoading } from "@/components/app-loading"
import { Toaster } from "@/components/ui/sonner"
import { MOCK } from "@/lib/app-config"

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
            // Keep what was read until "Oppdater", a booking or logout: going back to the inbox
            // or reopening a bilag must not read Fiken again just because the screen unmounted.
            gcTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  )
  // The session lives in sessionStorage, so the real first screen is only known after mount.
  const [booted, setBooted] = useState(false)
  useEffect(() => {
    // Mock mode: the fake Fiken must answer before the first request.
    const ready = MOCK ? import("@/mocks/start").then((m) => m.startMock()) : Promise.resolve()
    void ready.then(() => setBooted(true))
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      {booted ? children : <AppLoading />}
      <Toaster />
    </QueryClientProvider>
  )
}
