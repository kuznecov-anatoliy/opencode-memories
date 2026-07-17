# opencode-memories

> Long-term memory plugin for [OpenCode](https://github.com/opencode-ai) — persistent session memory, decision log, problems & chronology for AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

opencode-memories gives AI agents persistent memory across sessions. Instead of losing context when a session ends, the plugin:

- **Saves decisions** — architectural choices, design rationale, with status tracking (ACTIVE / SUPERSEDED / REVERTED)
- **Tracks problems** — known bugs, risks, with severity levels
- **Maintains chronology** — full history of agent-user conversations
- **Manages sessions** — create, switch, search across multiple memory sessions
- **Auto-preserves context** — POST-COMPACTION protocol saves critical context before session compression

---

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/kuznecov-anatoliy/opencode-memories.git
   cd opencode-memories
   npm install
   ```

2. Add the plugin to your OpenCode config (`opencode.json`):
   ```json
   {
     "plugins": [
       "./path/to/opencode-memories/src/memories-v5.9.ts"
     ]
   }
   ```

3. Restart OpenCode. The plugin will register automatically.

---

## Quick Start

Start a new session — the plugin will prompt you to create or attach a session:

```
💾 MEMORIES — Выбор сессии

📎 Привязать — выбрать существующую сессию
🆕 Создать — создать новую сессию
⏭ Пропустить — продолжить без сессии
```

Use commands via `@memories`:

```
@memories state                 — show current session memory
@memories add-decision "use MIT license" — add a decision
@memories add-problem "CI not configured" — add a problem
@memories close-problem 3        — close problem #3
@memories resolve-decision 2     — mark decision #2 as SUPERSEDED
```

---

## Commands

| Command | Description |
|---------|-------------|
| `@memories state` | Show current session MEMORY file |
| `@memories sessions` | List all sessions |
| `@memories search <query>` | Full-text search across all sessions |
| `@memories add-decision <text>` | Add a decision to the decision log |
| `@memories resolve-decision <id>` | Mark a decision as SUPERSEDED |
| `@memories add-problem <text>` | Add a problem |
| `@memories close-problem <id>` | Close a problem |

---

## How It Works

The plugin hooks into OpenCode's experimental plugin API:

- **`system.transform`** — injects session selection prompt into new tabs (SESSION-START protocol)
- **`messages.transform`** — detects unnamed sessions, injects POST-COMPACTION context
- **`session.compacted`** — triggers memory preservation after session compression
- **`tool`** — registers `@memories` commands

Data is stored in:
- **SQLite** (`opencode-memories.db`) — full-text search, session metadata, all structured data
- **MEMORY files** (`MEMORIES/`) — human-readable markdown snapshots of sessions

---

## Protocols

### SESSION-START
When a new tab opens, the plugin asks the user to select or create a memory session. This associates all future messages with a named session.

### POST-COMPACTION
After OpenCode compacts a session (summarizing old messages), the plugin injects a synthetic message instructing the agent to save the compacted context into the MEMORY file.

### AUTO-SAVE
After logical milestones (bug fixed, decision made, task completed), the plugin suggests saving to MEMORY.

---

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

**Note:** Memory files and the database may contain sensitive information from AI sessions. Add `MEMORIES/` and `*.db` to your project's `.gitignore` (included by default).

---

## License

[MIT](LICENSE)
