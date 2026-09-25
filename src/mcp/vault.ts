import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createAnnotation, HighlightData, locateAnnotation, parseHighlightData } from "../annotations.js"
import { highlightMarkup, isHighlightAround } from "../markup.js"

const ignoredDirectories = new Set([".git", ".obsidian", "node_modules", ".trash"])
const maxSearchFiles = 20_000

export interface NoteMatch {
  path: string
  excerpt: string
}

export interface HighlightResult {
  path: string
  occurrence: number
  alreadyHighlighted: boolean
}

export interface AnnotationResult {
  path: string
  id: string
  occurrence: number
  alreadyAnnotated: boolean
  commentUpdated: boolean
}

export class VaultFiles {
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<VaultFiles> {
    const canonicalRoot = await realpath(path.resolve(root))
    const rootInfo = await stat(canonicalRoot)
    if (!rootInfo.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${root}`)
    }

    return new VaultFiles(canonicalRoot)
  }

  async search(query: string, limit: number): Promise<NoteMatch[]> {
    const normalizedQuery = query.toLocaleLowerCase()
    const notes = await this.listMarkdownFiles()
    const matches: NoteMatch[] = []

    for (const notePath of notes) {
      if (matches.length >= limit) break

      const contents = await readFile(notePath.absolute, "utf8")
      const index = contents.toLocaleLowerCase().indexOf(normalizedQuery)
      if (index === -1) continue

      const excerptStart = Math.max(0, index - 100)
      const excerptEnd = Math.min(contents.length, index + query.length + 140)
      const excerpt = contents.slice(excerptStart, excerptEnd).replaceAll("\n", " ")
      const prefix = excerptStart > 0 ? "…" : ""
      const suffix = excerptEnd < contents.length ? "…" : ""
      matches.push({ path: notePath.relative, excerpt: `${prefix}${excerpt}${suffix}` })
    }

    return matches
  }

  async read(relativePath: string): Promise<string> {
    const absolutePath = await this.resolveMarkdownFile(relativePath)
    return readFile(absolutePath, "utf8")
  }

  async highlight(relativePath: string, text: string, occurrence?: number): Promise<HighlightResult> {
    return this.serializeWrites(() => this.highlightUnlocked(relativePath, text, occurrence))
  }

  async annotate(relativePath: string, text: string, occurrence?: number, comment = ""): Promise<AnnotationResult> {
    return this.serializeWrites(async () => {
      const absolutePath = await this.resolveMarkdownFile(relativePath)
      const contents = await readFile(absolutePath, "utf8")
      const offsets: number[] = []
      let position = 0
      while (position <= contents.length - text.length) {
        const offset = contents.indexOf(text, position)
        if (offset === -1) break
        offsets.push(offset)
        position = offset + text.length
      }
      if (offsets.length === 0) throw new Error(`The exact text was not found in ${relativePath}.`)
      if (occurrence === undefined && offsets.length > 1) {
        throw new Error(`Found ${offsets.length} matches. Pass occurrence (1-${offsets.length}) to choose one.`)
      }
      const selectedOccurrence = occurrence ?? 1
      const offset = offsets[selectedOccurrence - 1]
      if (offset === undefined) throw new Error(`Occurrence ${selectedOccurrence} is outside the ${offsets.length} matches.`)

      const dataPath = await this.pluginDataPath()
      let data: HighlightData = { mode: "markdown", visible: true, annotations: [] }
      try {
        const info = await lstat(dataPath)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plugin data must be a regular file.")
        data = parseHighlightData(JSON.parse(await readFile(dataPath, "utf8")))
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      const existing = data.annotations.find((annotation) => annotation.path === relativePath && annotation.quote === text && locateAnnotation(contents, annotation) === offset)
      if (existing) {
        if (!comment || comment === existing.comment) {
          return { path: relativePath, id: existing.id, occurrence: selectedOccurrence, alreadyAnnotated: true, commentUpdated: false }
        }
        await this.writePluginData(dataPath, {
          ...data,
          annotations: data.annotations.map((annotation) => annotation.id === existing.id ? { ...annotation, comment } : annotation),
        })
        return { path: relativePath, id: existing.id, occurrence: selectedOccurrence, alreadyAnnotated: true, commentUpdated: true }
      }
      const annotation = createAnnotation(relativePath, contents, offset, text, comment)
      if (locateAnnotation(contents, annotation) !== offset) {
        throw new Error("This selection cannot be anchored uniquely. Choose a longer passage.")
      }
      const updated = { ...data, annotations: [...data.annotations, annotation] }
      await this.writePluginData(dataPath, updated)
      return { path: relativePath, id: annotation.id, occurrence: selectedOccurrence, alreadyAnnotated: false, commentUpdated: false }
    })
  }

  private async pluginDataPath(): Promise<string> {
    let current = this.root
    for (const component of [".obsidian", "plugins", "ai-highlight"]) {
      current = path.join(current, component)
      try {
        await mkdir(current)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("The Obsidian plugin data directory must not contain symlinks.")
      }
    }
    return path.join(current, "data.json")
  }

  private async writePluginData(dataPath: string, data: HighlightData): Promise<void> {
    const temporaryPath = `${dataPath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" })
      await rename(temporaryPath, dataPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async highlightUnlocked(relativePath: string, text: string, occurrence?: number): Promise<HighlightResult> {
    const absolutePath = await this.resolveMarkdownFile(relativePath)
    const original = await readFile(absolutePath, "utf8")
    const matches = findOccurrences(original, text)

    if (matches.length === 0) {
      throw new Error(`The exact text was not found in ${relativePath}. Read the note and retry with an exact excerpt.`)
    }

    if (occurrence === undefined && matches.length > 1) {
      throw new Error(`Found ${matches.length} exact matches in ${relativePath}. Pass occurrence (1-${matches.length}) to choose one.`)
    }

    const selectedOccurrence = occurrence ?? 1
    const matchIndex = selectedOccurrence - 1
    const selected = matches[matchIndex]
    if (selected === undefined) {
      throw new Error(`Occurrence ${selectedOccurrence} is outside the ${matches.length} matches in ${relativePath}.`)
    }

    if (selected.alreadyHighlighted) {
      return { path: relativePath, occurrence: selectedOccurrence, alreadyHighlighted: true }
    }

    const updated = `${original.slice(0, selected.start)}${highlightMarkup(text)}${original.slice(selected.end)}`
    const current = await readFile(absolutePath, "utf8")
    if (current !== original) {
      throw new Error(`The note changed while the highlight was being prepared. Read ${relativePath} again and retry.`)
    }

    await this.replaceContents(absolutePath, updated)
    return { path: relativePath, occurrence: selectedOccurrence, alreadyHighlighted: false }
  }

  private serializeWrites<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async resolveMarkdownFile(relativePath: string): Promise<string> {
    if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
      throw new Error("Use a relative path to a Markdown note inside the configured vault.")
    }

    const components = relativePath.split(/[\\/]/)
    if (components.some((component) => component === ".." || component.startsWith("."))) {
      throw new Error("Hidden files and paths outside the vault are not accessible.")
    }

    const normalizedPath = components.join(path.sep)
    if (path.extname(normalizedPath).toLocaleLowerCase() !== ".md") {
      throw new Error("Only Markdown notes can be read or modified.")
    }

    const absolutePath = path.resolve(this.root, normalizedPath)
    if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("The note path must stay inside the configured vault.")
    }

    const fileInfo = await lstat(absolutePath)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("The path must refer to a regular Markdown file.")
    }

    const canonicalPath = await realpath(absolutePath)
    if (!canonicalPath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("The note path must stay inside the configured vault.")
    }

    return canonicalPath
  }

  private async listMarkdownFiles(): Promise<Array<{ absolute: string; relative: string }>> {
    const files: Array<{ absolute: string; relative: string }> = []
    const pendingDirectories = [this.root]

    while (pendingDirectories.length > 0 && files.length < maxSearchFiles) {
      const currentDirectory = pendingDirectories.pop()
      if (currentDirectory === undefined) continue

      const entries = await readdir(currentDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue

        const absolute = path.join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) {
            pendingDirectories.push(absolute)
          }
          continue
        }

        if (entry.isFile() && !entry.name.startsWith(".") && path.extname(entry.name).toLocaleLowerCase() === ".md") {
          files.push({
            absolute,
            relative: path.relative(this.root, absolute).split(path.sep).join("/"),
          })
          if (files.length >= maxSearchFiles) break
        }
      }
    }

    return files.sort((left, right) => left.relative.localeCompare(right.relative))
  }

  private async replaceContents(absolutePath: string, contents: string): Promise<void> {
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`
    const mode = (await stat(absolutePath)).mode

    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode, flag: "wx" })
      await rename(temporaryPath, absolutePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

interface Occurrence {
  start: number
  end: number
  alreadyHighlighted: boolean
}

function findOccurrences(contents: string, text: string): Occurrence[] {
  const occurrences: Occurrence[] = []
  let position = 0

  while (position <= contents.length - text.length) {
    const start = contents.indexOf(text, position)
    if (start === -1) break
    const end = start + text.length
    const before = contents.slice(start - 6, start) === "<mark>" ? "<mark>" : contents.slice(start - 2, start)
    const after = contents.slice(end, end + 7) === "</mark>" ? "</mark>" : contents.slice(end, end + 2)
    const alreadyHighlighted = isHighlightAround(before, after)
    occurrences.push({ start, end, alreadyHighlighted })
    position = end
  }

  const markup = highlightMarkup(text)
  if (markup.startsWith("<mark>")) {
    const innerStartOffset = "<mark>".length
    let markupPosition = 0
    while (markupPosition < contents.length) {
      const markupStart = contents.indexOf(markup, markupPosition)
      if (markupStart === -1) break

      const start = markupStart + innerStartOffset
      if (!occurrences.some((occurrence) => occurrence.start === start)) {
        occurrences.push({ start, end: start + text.length, alreadyHighlighted: true })
      }
      markupPosition = markupStart + markup.length
    }
  }

  return occurrences.sort((left, right) => left.start - right.start)
}
