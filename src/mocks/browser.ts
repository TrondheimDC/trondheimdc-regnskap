import { setupWorker } from "msw/browser"
import { handlers } from "./fiken-mock"

let started: Promise<void> | undefined

/**
 * Routes /api/fiken to the in-memory Fiken; everything else goes to the network. Once per page
 * (strict mode runs the boot effect twice).
 */
export function startMock(): Promise<void> {
  started ??= setupWorker(...handlers)
    .start({ onUnhandledFrame: "bypass", quiet: true })
    .then(() => {})
  return started
}
