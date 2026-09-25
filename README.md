# AI Highlight for Obsidian

Select text in Obsidian and run **Highlight selected text**, or let Claude Desktop, Claude Code, or Codex find and highlight an exact passage through MCP. The plugin writes native `==highlight==` markup, which Obsidian and Quartz render.

The MCP server uses local stdio and the vault path you give it. It exposes three tools:

- `search_notes` finds matching notes and returns short excerpts.
- `read_note` reads one note from the configured vault.
- `highlight_text` wraps one exact occurrence in Obsidian highlight markup.

The MCP server reads and writes Markdown files directly. Save open notes in Obsidian before calling `highlight_text`. It only accesses Markdown files beneath the configured vault, skips hidden folders and symlinks while searching, and rejects paths outside the vault. Repeated exact matches require an `occurrence` number so it does not guess.

## Build

Requires Node.js 20 or newer.

```sh
npm install
npm run build
npm run typecheck
```

The build creates `plugin/main.js` for Obsidian and `dist/mcp-server.js` for MCP clients.

## Install the Obsidian plugin

Copy `plugin/manifest.json` and `plugin/main.js` into a folder named `ai-highlight` inside your vault's `.obsidian/plugins/` directory. In Obsidian, open **Settings → Community plugins**, enable **AI Highlight**, then select text and run **Highlight selected text** from the command palette.

The plugin uses only Obsidian's editor API and works on desktop and mobile.

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

Search is case-insensitive. Highlighting requires an exact, case-sensitive match. Single-line text containing `=`, `&`, `<`, or `>` uses an escaped HTML `<mark>` wrapper; this keeps the visible text intact and avoids conflicting with Obsidian and Quartz's `==...==` delimiter syntax.
