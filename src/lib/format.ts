// Norwegian date labels for the web app.

/** "2026-03" -> "Mars 2026" */
export function formatMonth(month: string): string {
  const label = new Date(`${month}-01T12:00:00`).toLocaleString("nb-NO", {
    month: "long",
    year: "numeric",
  })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** "2026-03-08" or an ISO timestamp -> "8. mars 2026" */
export function formatDay(date: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date)
  return d.toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" })
}
