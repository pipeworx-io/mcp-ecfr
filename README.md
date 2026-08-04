# mcp-ecfr

eCFR (Electronic Code of Federal Regulations) MCP.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ecfr data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
