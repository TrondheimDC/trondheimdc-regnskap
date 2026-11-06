// What server rendering sees: the mock only runs in the browser, where next.config aliases this
// module to ./browser.ts (msw/browser has no Node build).
export async function startMock(): Promise<void> {}
