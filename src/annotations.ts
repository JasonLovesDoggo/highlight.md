export type HighlightMode = "markdown" | "overlay"

export interface Annotation {
  id: string
  path: string
  quote: string
  prefix: string
  suffix: string
  offset: number
  comment: string
  createdAt: string
}

export interface HighlightData {
  mode: HighlightMode
  annotations: Annotation[]
}

export function parseHighlightData(value: unknown): HighlightData {
  const empty: HighlightData = { mode: "markdown", annotations: [] }
  if (typeof value !== "object" || value === null) return empty

  const mode = "mode" in value && value.mode === "overlay" ? "overlay" : "markdown"
  if (!("annotations" in value) || !Array.isArray(value.annotations)) {
    return { mode, annotations: [] }
  }

  const annotations: Annotation[] = []
  for (const item of value.annotations) {
    if (typeof item !== "object" || item === null) continue
    if (!("id" in item) || typeof item.id !== "string") continue
    if (!("path" in item) || typeof item.path !== "string") continue
    if (!("quote" in item) || typeof item.quote !== "string" || item.quote.length === 0) continue
    if (!("prefix" in item) || typeof item.prefix !== "string") continue
    if (!("suffix" in item) || typeof item.suffix !== "string") continue
    if (!("offset" in item) || typeof item.offset !== "number" || !Number.isSafeInteger(item.offset) || item.offset < 0) continue
    if (!("comment" in item) || typeof item.comment !== "string") continue
    if (!("createdAt" in item) || typeof item.createdAt !== "string") continue
    annotations.push({
      id: item.id, path: item.path, quote: item.quote, prefix: item.prefix,
      suffix: item.suffix, offset: item.offset, comment: item.comment, createdAt: item.createdAt,
    })
  }
  return { mode, annotations }
}

export function createAnnotation(path: string, contents: string, offset: number, quote: string, comment = ""): Annotation {
  return {
    id: crypto.randomUUID(), path, quote,
    prefix: contents.slice(Math.max(0, offset - 40), offset),
    suffix: contents.slice(offset + quote.length, offset + quote.length + 40),
    offset, comment, createdAt: new Date().toISOString(),
  }
}

export function locateAnnotation(contents: string, annotation: Annotation): number | null {
  const candidates: Array<{ offset: number; context: number }> = []
  let position = 0
  while (position <= contents.length - annotation.quote.length) {
    const offset = contents.indexOf(annotation.quote, position)
    if (offset === -1) break
    let context = 0
    for (let index = 1; index <= annotation.prefix.length; index++) {
      if (contents[offset - index] !== annotation.prefix[annotation.prefix.length - index]) break
      context++
    }
    for (let index = 0; index < annotation.suffix.length; index++) {
      if (contents[offset + annotation.quote.length + index] !== annotation.suffix[index]) break
      context++
    }
    candidates.push({ offset, context })
    position = offset + annotation.quote.length
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].offset
  const best = Math.max(...candidates.map((candidate) => candidate.context))
  const matching = candidates.filter((candidate) => candidate.context === best)
  if (matching.length === 1 && best > 0) return matching[0].offset
  return null
}
