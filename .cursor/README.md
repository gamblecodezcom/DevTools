# Cursor Bootstrap Policy

- On session start, call `gcz.bootstrap({ project: "DevTools", client: "Cursor" })`.
- At session end, persist a summary with `unified.memory.set({ project: "DevTools", source: "Cursor", key: "last_session_summary", value: {...} })`.
- If shared context changed, call `unified.context.write({ project: "DevTools", source: "Cursor", context: {...} })`.
