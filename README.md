# mcp-ecfr

eCFR (Electronic Code of Federal Regulations) MCP.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_regulations` | Full-text search across all 50 titles of the US Code of Federal Regulations (federal agency regulations) via the official eCFR API. Returns matching sections with citation, heading, and excerpt. e.g. "drone operation", "food labeling", "overtime pay". Optionally restrict to one CFR title number. Keyless. |
| `list_titles` | List all 50 titles of the US Code of Federal Regulations (Title 1 General Provisions … Title 50 Wildlife and Fisheries), with currency dates. This is the index for the `title` filter in search_regulations. Keyless. |
| `title_structure` | Get the top-level structure (chapters/subtitles) of one CFR title — the agencies and major divisions within that title. Returns a summarized one-level view, not the full deep tree. Keyless. |
| `get_section_text` | Get the actual REGULATION TEXT currently in force — a single CFR section OR a whole CFR part. PREFER for "what does 14 CFR 91.113 say", "read the text of <citation>", "the exact wording of <regulation>", "text of 22 CFR part 120", "40 CFR part 261". Pass the title number plus EITHER a section (e.g. title 14, section "91.113" → that section) OR a part (e.g. title 22, part "120" → every section in the part). Returns the heading(s) and full paragraph text. Use search_regulations first to find the citation if unknown. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ecfr": {
      "url": "https://gateway.pipeworx.io/ecfr/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ecfr/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ecfr data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
