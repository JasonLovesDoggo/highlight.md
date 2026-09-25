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
  },
  required: ["path", "text"],
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
    { name: "obsidian-highlight", version: "0.1.0" },
    {
      instructions:
        "Use search_notes or read_note to confirm the target and exact text before calling highlight_text. Paths are relative to the configured Obsidian vault. If a phrase has multiple exact matches, specify its occurrence. Save open notes in Obsidian before using the file-writing tool.",
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
        "Wrap one exact, single-line occurrence in Obsidian highlight syntax (==text==). Read the note first. This writes the note on disk; save open editor changes before calling.",
      inputSchema: highlightTextSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, text, occurrence }) => {
      if (text.includes("\n") || text.includes("\r")) {
        return { content: [{ type: "text", text: "Highlight one line at a time." }], isError: true }
      }

      try {
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

  await serveStdio(() => server)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
