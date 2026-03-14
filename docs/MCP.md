# MCP Client Setup (Codex / Claude / Cursor)

Use the unified MCP endpoint:

```json
{
  "mcpServers": {
    "gcz-mcp": {
      "url": "https://ai.gamblecodez.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GCZ_MCP_TOKEN}"
      }
    }
  }
}
```

Notes:
- Set `GCZ_MCP_TOKEN` in your environment or secrets manager.
- For GitHub Actions, store `GCZ_MCP_TOKEN` in the `MCP` environment secrets and use `https://ai.gamblecodez.com/mcp`.
