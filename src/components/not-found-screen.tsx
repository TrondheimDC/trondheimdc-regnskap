import Link from "next/link"
import { ErrorScreen } from "@/components/error-screen"
import { TAccountNotFoundIllustration } from "@/components/illustrations"
import { Button } from "@/components/ui/button"

export function NotFoundScreen() {
  return (
    <ErrorScreen
      illustration={<TAccountNotFoundIllustration />}
      code="404"
      title="Fant ikke siden"
      body="Lenken er gammel eller feilskrevet."
      actions={
        <Button asChild>
          <Link href="/">Til start</Link>
        </Button>
      }
    />
  )
}
