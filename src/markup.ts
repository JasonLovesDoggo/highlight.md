export function highlightMarkup(text: string): string {
  if (!text.includes("=") && !/[&<>]/.test(text)) return `==${text}==`

  const safeText = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `<mark>${safeText}</mark>`
}

export function isHighlightAround(before: string, after: string): boolean {
  return (before === "==" && after === "==") || (before === "<mark>" && after === "</mark>")
}
