# Codex Bootstrap Policy

- On session start, call `gcz.bootstrap({ project: "DevTools", client: "Codex" })`.
- At session end, persist a summary with `unified.memory.set({ project: "DevTools", source: "Codex", key: "last_session_summary", value: {...} })`.
- If shared context changed, call `unified.context.write({ project: "DevTools", source: "Codex", context: {...} })`.
