# DevTools — Claude Code Workspace

## Environment
- **Platform:** Android/Termux (arm64)
- **Shell:** /data/data/com.termux/files/usr/bin/bash
- **TMPDIR:** /data/data/com.termux/files/usr/tmp
- **PREFIX:** /data/data/com.termux/files/usr
- **Workspace:** /storage/emulated/0/DevTools (symlinked from ~/storage/shared/DevTools)
- **Git remote:** git@github.com:gamblecodezcom/DevTools.git

## Permissions
- `dangerouslyAllowAllTools: true` — full bash, file, and network access
- This is a local development machine. No approval needed for any tool.
- Run all bash commands with dangerouslyDisableSandbox: true

## Project Purpose
DevTools is a personal developer toolkit for managing GitHub workflows, PRs, automation scripts, and development utilities from an Android device via Termux.

## Existing Tools (in ~/bin/)
- `prr.sh` — PR review: extracts actionable issues/CI status from GitHub PRs
- `prr2.sh` — processes prr output into todolist.md
- `prm.sh` — PR management helper

## Architecture
```
DevTools/
├── CLAUDE.md           # This file
├── README.md           # Project overview
├── src/
│   ├── cli/            # CLI tools and commands
│   ├── github/         # GitHub API utilities
│   ├── utils/          # Shared utilities
│   └── dashboard/      # Dev dashboard (web UI or TUI)
├── bin/                # Executable scripts
├── config/             # Config files
└── tests/              # Tests
```

## Termux Issues & Fixes
- If bash tool fails: run `~/bin/fix-claude-tools.sh` in Termux
- ripgrep must be symlinked: `ln -sf $(which rg) ~/.../vendor/ripgrep/arm64-android/rg`
- TMPDIR must be set to `$PREFIX/tmp` (not /tmp)

## Coding Standards
- Bash scripts: use `#!/data/data/com.termux/files/usr/bin/bash` shebang
- Node.js: ES modules preferred, Node 18+
- No unnecessary dependencies — keep it lean for mobile
