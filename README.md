# opencode-memories

> A 3-tier hybrid memory plugin for [OpenCode](https://github.com/opencode-ai) with endless sessions (soft compaction). Persistent session memory, decision board, problems & chronology for AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

opencode-memories gives AI agents persistent memory across sessions using a **3-tier hybrid architecture**:

### 🧠 1. Compressed Memory
Keeps the agent aware of where it is and what it's doing in the moment. Consists of a **dashboard** (decision board, current state, known problems) and a **recent message history** compressed by the agent. Updates automatically — on agent's decision, on `save` command, or on auto-compaction trigger.

### 💾 2. Atomic Memory
Stores **every single message as-is**, unprocessed, in the SQLite database. Think of it as the source of truth:
- **Recall** — search anything when you need to remember
- **Anti-rot** — refreshes compressed memory with fresh context, preventing context decay
- **Full recovery** — rebuilds compressed memory from scratch if it gets corrupted

### 📂 3. Session Isolation (Multi-tasking within a project)
Each task gets its own named session within a project. Start a session for a specific feature, script, or functionality — give it a meaningful name. Work endlessly in one tab until the task is done. Come back a month later — the agent remembers everything: what was done, why, and can pick up right where you left off.

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
       "./path/to/opencode-memories/src/memories.ts"
     ]
   }
   ```

3. Restart OpenCode. The plugin will register automatically.

---

## Quick Start

Start a new session — the plugin will prompt you to create or attach a session:

```
💾 MEMORIES — Session Selection

📎 Attach — select an existing session
🆕 Create — create a new session
⏭ Skip — continue without a session
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
| `@memories add-decision <text>` | Add a decision to the decision board |
| `@memories resolve-decision <id>` | Mark a decision as SUPERSEDED |
| `@memories add-problem <text>` | Add a problem |
| `@memories close-problem <id>` | Close a problem |
| `@memories rename <name>` | Rename current session |
| `@memories new <name>` | Create a new session |
| `@memories switch <name>` | Switch to another session |
| `@memories attach <name>` | Attach this tab to an existing session |
| `@memories detach` | Detach this tab from its session |
| `@memories delete <name>` | Delete a session completely |
| `@memories sql <query>` | Run a SELECT query on the session database |
| `@memories cleanup` | Clean up orphan records |

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
