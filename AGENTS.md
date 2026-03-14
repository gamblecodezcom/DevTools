# DevTools AI Agent Configuration

## MCP Server
**External**: `https://ai.gamblecodez.com/mcp` | Token: `gcz-mcp-2026`
**Localhost**: `http://localhost:7331/mcp` (no token)

## Bootstrap Policy (Required)

- Before any task, call `gcz.bootstrap({ project: "DevTools", client: "<agent name>" })`.
- CLI shells auto-run `/var/www/html/gcz/ai/mcp/bootstrap.sh` unless `GCZ_BOOTSTRAP_DISABLE=1`.
- Web coders must call `gcz.bootstrap` manually at session start.
- At end of session, persist a summary with `unified.memory.set({ project: "DevTools", source: "<agent name>", key: "last_session_summary", value: {...} })`.
- If shared context changed, call `unified.context.write({ ... })`.

## Quick Connect

### Claude Code CLI (on VPS)
```json
{ "mcpServers": { "gcz": { "url": "http://localhost:7331/mcp" } } }
```

### Claude Web / Remote
```json
{ "mcpServers": { "gcz": { "url": "https://ai.gamblecodez.com/mcp", "headers": { "Authorization": "Bearer gcz-mcp-2026" } } } }
```

## Key Tools for This Project

```bash
# Memory
unified.memory.set  { project: "DevTools", key: "...", value: {...} }
unified.memory.get  { project: "DevTools" }

# Todos
unified.todo.add    { project: "DevTools", title: "...", priority: 5 }
unified.todo.list   { project: "DevTools", status: "open" }

# Git
gitops.status       { project: "devtools" }
gitops.summary      { project: "devtools" }

# Files
unified.file.read   { path: "/var/www/html/DevTools/..." }
unified.file.list   { path: "/var/www/html/DevTools" }

# Infrastructure
infra.system.health {}
infra.pm2.list      {}
```

## Full Docs
See `/var/www/html/gcz/AGENTS.md` for the complete tool reference.
