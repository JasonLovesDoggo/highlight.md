# AI Highlight for Obsidian

Select text in Obsidian and run **Highlight selected text**, or let Claude Desktop, Claude Code, or Codex find and highlight an exact passage through MCP. Choose **Markdown markup** or **Annotations** under **Settings → AI Highlight**. Markdown mode writes native `==highlight==` markup, which Obsidian and Quartz render. Annotation mode leaves the note unchanged and draws a highlight over the editor.

The MCP server uses local stdio and the vault path you give it. It exposes three tools:

- `search_notes` finds matching notes and returns short excerpts.
- `read_note` reads one note from the configured vault.
- `highlight_text` highlights one exact occurrence. Pass `mode: "overlay"` to store an annotation without changing the note, optionally with a `comment`.

The MCP server reads Markdown files directly. Markdown mode writes the note, so save open notes in Obsidian before calling it. Overlay mode writes the plugin's `.obsidian/plugins/ai-highlight/data.json` file instead. It only accesses Markdown files beneath the configured vault, skips hidden folders and symlinks while searching, and rejects paths outside the vault. Repeated exact matches require an `occurrence` number so it does not guess.

## Build

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm run typecheck
```

The build creates `plugin/main.js` for Obsidian and `dist/mcp-server.js` for MCP clients.

## Install the Obsidian plugin

Copy `plugin/manifest.json`, `plugin/main.js`, and `plugin/styles.css` into a folder named `ai-highlight` inside your vault's `.obsidian/plugins/` directory. In Obsidian, open **Settings → Community plugins**, enable **AI Highlight**, then select text and run **Highlight selected text** from the command palette. In **Settings → AI Highlight**, select the editing mode. **Comment on selected text** saves a comment on a new or existing annotation. Hover over a commented highlight to read it; **Dismiss** closes the card and **Remove annotation** deletes it. **Show annotations in current note** lists comments and lets you remove them. The command palette also has **Hide all annotations**, **Show all annotations**, and **Remove all annotations**. Removal asks for confirmation.

Annotations are saved separately from Markdown. They appear in Obsidian's editor with this plugin enabled, including on mobile, but do not automatically appear in Reading view, Quartz, or GitHub. The plugin uses the saved quote and nearby text to relocate the highlight as a note changes. Deleted or ambiguous text has no visible highlight until it can be anchored uniquely again.

The `data.json` file can contain your comments and quoted text. If your vault is in a public Git repository, add `.obsidian/plugins/ai-highlight/data.json` to that repository's `.gitignore` before creating annotations.

## Connect Claude Desktop

On macOS, add an entry to `~/Library/Application Support/Claude/claude_desktop_config.json`. Replace both paths with absolute paths on your machine:

```json
{
  "mcpServers": {
    "obsidian-highlight": {
      "command": "node",
      "args": [
        "/path/to/obsidian-highlight-mcp/dist/mcp-server.js",
        "--vault",
        "/path/to/your/Obsidian/vault"
      ]
    }
  }
}
```

Restart Claude Desktop after changing its configuration.

For Claude Code, register the same local server from a terminal:

```sh
claude mcp add --scope user obsidian-highlight -- node \
  "/path/to/obsidian-highlight-mcp/dist/mcp-server.js" \
  --vault "/path/to/your/Obsidian/vault"
```

Check the connection with `claude mcp list`.

## Connect Codex

Add this to `~/.codex/config.toml`. Use the same absolute paths:

```toml
[mcp_servers.obsidian-highlight]
command = "node"
args = [
  "/path/to/obsidian-highlight-mcp/dist/mcp-server.js",
  "--vault",
  "/path/to/your/Obsidian/vault",
]
```

Restart Codex or reload its MCP servers. You can also set `OBSIDIAN_VAULT_PATH` in the server process environment and omit `--vault`.

## Example requests

- “Search my vault for ‘atomic habits’ and show me the matching note.”
- “Highlight ‘the exact passage’ in `Books/Example.md`.”
- “Highlight the second occurrence of ‘important phrase’ in `Projects/Plan.md`.”
- “Add an overlay highlight and comment to ‘the exact passage’ in `Books/Example.md` without changing the note.”

Search is case-insensitive. Highlighting requires an exact, case-sensitive match. Single-line text containing `=`, `&`, `<`, or `>` uses an escaped HTML `<mark>` wrapper; this keeps the visible text intact and avoids conflicting with Obsidian and Quartz's `==...==` delimiter syntax.
