import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { VaultFiles } from "./vault.js"

interface SearchNotesInput {
  query: string
  limit?: number
}

interface ReadNoteInput {
  path: string
}

interface HighlightTextInput {
  path: string
  text: string
  occurrence?: number
  mode?: "markdown" | "overlay"
  comment?: string
}

interface SuggestEditInput {
  path: string
  text: string
  replacement: string
  occurrence?: number
  comment?: string
  autoApply?: boolean
}

const searchNotesSchema = fromJsonSchema<SearchNotesInput>({
  type: "object",
  properties: {
    query: { type: "string", minLength: 2, description: "Text to find inside note contents." },
    limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum matching notes to return. Defaults to 10." },
  },
  required: ["query"],
  additionalProperties: false,
})

const readNoteSchema = fromJsonSchema<ReadNoteInput>({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Vault-relative Markdown note path." },
  },
  required: ["path"],
  additionalProperties: false,
})

const highlightTextSchema = fromJsonSchema<HighlightTextInput>({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Vault-relative Markdown note path." },
    text: { type: "string", minLength: 1, description: "Exact, single-line text to highlight." },
    occurrence: { type: "integer", minimum: 1, description: "1-based exact match to highlight when text appears more than once." },
    mode: { type: "string", enum: ["markdown", "overlay"], description: "Markdown changes the note. Overlay stores an annotation without changing the note. Defaults to markdown." },
    comment: { type: "string", description: "Optional comment for overlay mode." },
  },
  required: ["path", "text"],
  additionalProperties: false,
})

const suggestEditSchema = fromJsonSchema<SuggestEditInput>({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Vault-relative Markdown note path." },
    text: { type: "string", minLength: 1, description: "Exact text to replace. Read the note first." },
    replacement: { type: "string", description: "Replacement text. Empty text proposes or applies a deletion." },
    occurrence: { type: "integer", minimum: 1, description: "1-based exact match when the text appears more than once." },
    comment: { type: "string", description: "Optional concept or reason for this edit." },
    autoApply: { type: "boolean", description: "When true, write the replacement into the note immediately instead of saving a review suggestion. Defaults to false." },
  },
  required: ["path", "text", "replacement"],
  additionalProperties: false,
})

function configuredVaultPath(): string {
  const argumentIndex = process.argv.indexOf("--vault")
  const argumentPath = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined
  const configuredPath = argumentPath ?? process.env.OBSIDIAN_VAULT_PATH
  if (configuredPath === undefined || configuredPath.length === 0) {
    throw new Error("Set OBSIDIAN_VAULT_PATH or pass --vault <path> to your Obsidian vault.")
  }
  return configuredPath
}

async function main(): Promise<void> {
  const vault = await VaultFiles.open(configuredVaultPath())
  const server = new McpServer(
    { name: "obsidian-highlight", version: "0.3.0" },
    {
      instructions:
        "Use search_notes or read_note to confirm the target and exact text before making a change. Paths are relative to the configured Obsidian vault. If a phrase has multiple exact matches, specify its occurrence. Use highlight_text in overlay mode for a concept or comment without changing the note. Use suggest_edit to store a proposed replacement as a reviewable diff; set autoApply true only when asked to write the note immediately. Save open notes in Obsidian before using markdown mode or autoApply.",
    },
  )

  server.registerTool(
    "search_notes",
    {
      description: "Find Markdown notes containing a phrase and return short excerpts with vault-relative paths.",
      inputSchema: searchNotesSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const matches = await vault.search(query, limit ?? 10)
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No notes matched: ${query}` }] }
      }

      return {
        content: [
          {
            type: "text",
            text: matches.map((match) => `${match.path}\n${match.excerpt}`).join("\n\n"),
          },
        ],
      }
    },
  )

  server.registerTool(
    "read_note",
    {
      description: "Read a Markdown note from the configured vault. Use the vault-relative path returned by search_notes.",
      inputSchema: readNoteSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const contents = await vault.read(path)
      const maximumCharacters = 20_000
      const truncatedContents = contents.length > maximumCharacters ? `${contents.slice(0, maximumCharacters)}\n… note truncated …` : contents
      return { content: [{ type: "text", text: truncatedContents }] }
    },
  )

  server.registerTool(
    "highlight_text",
    {
      description:
        "Highlight one exact occurrence. Markdown mode writes ==text== into the note; overlay mode stores a separate annotation and can include a comment. Read the note first.",
      inputSchema: highlightTextSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, text, occurrence, mode, comment }) => {
      if ((mode ?? "markdown") === "markdown" && (text.includes("\n") || text.includes("\r"))) {
        return { content: [{ type: "text", text: "Highlight one line at a time." }], isError: true }
      }
      if (comment && mode !== "overlay") {
        return { content: [{ type: "text", text: "Comments require overlay mode." }], isError: true }
      }

      try {
        if (mode === "overlay") {
          const result = await vault.annotate(path, text, occurrence, comment)
          const message = result.commentUpdated
            ? `Updated the comment for annotation ${result.id} in ${result.path}.`
            : result.alreadyAnnotated
            ? `That selection already has an annotation in ${result.path} (ID ${result.id}).`
            : `Annotated occurrence ${result.occurrence} in ${result.path} without changing the note (ID ${result.id}).`
          return { content: [{ type: "text", text: message }] }
        }
        const result = await vault.highlight(path, text, occurrence)
        const message = result.alreadyHighlighted
          ? `That text is already highlighted in ${result.path} (occurrence ${result.occurrence}).`
          : `Highlighted occurrence ${result.occurrence} in ${result.path}.`
        return { content: [{ type: "text", text: message }] }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: [{ type: "text", text: message }], isError: true }
      }
    },
  )

  server.registerTool(
    "suggest_edit",
    {
      description: "Suggest an exact-text replacement as a rendered diff in Obsidian, or apply it immediately when autoApply is true. No separate preview step.",
      inputSchema: suggestEditSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, text, replacement, occurrence, comment, autoApply }) => {
      if (replacement === text) {
        return { content: [{ type: "text", text: "Replacement is identical to the selected text." }], isError: true }
      }
      try {
        if (autoApply) {
          const result = await vault.applyEdit(path, text, replacement, occurrence)
          return { content: [{ type: "text", text: `Applied occurrence ${result.occurrence} in ${result.path}.` }] }
        }
        const result = await vault.annotate(path, text, occurrence, comment, replacement)
        const message = result.suggestionUpdated
          ? `Updated suggestion ${result.id} in ${result.path}.`
          : result.alreadyAnnotated
          ? `That selection already has suggestion ${result.id} in ${result.path}.`
          : `Saved suggestion ${result.id} for occurrence ${result.occurrence} in ${result.path}. The note was not changed.`
        return { content: [{ type: "text", text: message }] }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: [{ type: "text", text: message }], isError: true }
      }
    },
  )

  await serveStdio(() => server)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
