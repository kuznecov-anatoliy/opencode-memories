# opencode-memories

> **3-tier hybrid memory plugin for [OpenCode](https://github.com/opencode-ai)** — endless sessions (soft compaction), persistent context, atomic message archive, and session isolation for multi-tasking with AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-blue)](https://github.com/opencode-ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

---

## Overview

opencode-memories gives AI agents **permanent context** across sessions using a **3-tier hybrid architecture** — the only plugin that combines lossless message storage, a structured decision dashboard, and infinite sessions without losing history.

### 🧠 1. Compressed Memory — *context awareness*
The agent always knows where it is and what it's doing. A structured **dashboard** (decision board, current state, known problems) plus **recent message history** — all compressed by the agent itself. Updates on three triggers: agent's decision, `save` command, or auto-compaction.

### 💾 2. Atomic Memory — *source of truth*
**Every message stored as-is** in SQLite with full-text search (FTS5). Never compressed, never summarized. Used for:
- **Recall** — search anything by keyword, even months later
- **Anti-rot** — refreshes compressed memory to prevent context decay
- **Full recovery** — rebuilds the dashboard from scratch if corrupted

### 📂 3. Session Isolation — *multi-tasking within a project*
Each task gets its **own named session**. Work on feature A in one tab, bug B in another — each with its own memory, decisions, and history. Come back a month later — the agent remembers everything: what was done, why, and can pick up right where you left off.

---

## Why opencode-memories?

| Problem | Solution |
|---------|----------|
| Agent forgets context after session ends | **Session resume** — memory lives outside the context window |
| Session compaction kills history | **Soft compaction** — plugin captures everything before compression |
| Can't find that one decision from weeks ago | **Atomic archive** — every message in SQLite with FTS5 search |
| Context rot in long sessions | **Structured overwrite** — dashboard replaces itself, never accumulates noise |
| Plugin crashes lose data | **Atomic persist** — write-to-tmp + rename, main DB never corrupted |
| One session pollutes another | **Session isolation** — separate memory per task within the same project |

---

## Table of Contents

- [Overview & Architecture](#overview) — how the 3-tier memory works
- [Why opencode-memories?](#why-opencode-memories) — key differentiators at a glance
- [Installation](#installation) — setup guide
- [Quick Start](#quick-start) — first session in 30 seconds
- [Commands](#commands) — full command reference
- [How It Works](#how-it-works) — technical architecture
- [Protocols](#protocols) — SESSION-START, POST-COMPACTION, AUTO-SAVE
- [Security](#security) — data safety
- [License](#license)

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
