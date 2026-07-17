/**
 * memories-v5.9.ts — Plugin for Opencode (v5.9)
 *
 * v5.9: unattached session protections (3 problems):
 *   F1: compactingHandler guard — skip compaction for sessionSelectPending
 *   F2: compactingHandler fallback name — generateUniqueMdPath('Session',...) instead of 'unnamed'
 *   F3: messagesTransformHandler guard — skip POST-COMPACTION for unnamed sessions
 *   F4: messagesTransformHandler guard — skip POST-COMPACTION while sessionSelectPending
 *   F5+F6: eventHandler session.compacted — force-naming + clear sessionSelectPending/sessionStartInjected
 *
 * v5.8: fix unnamed compactName (isDisposed guard + name recovery from DB + typeof guard)
 * v5.7: fix POST-COMPACTION filtered by SDK, try-catch, diag improvements
 * v5.6: manual POST-COMPACTION injection moved from chat.message (parts.unshift)
 *       to messages.transform (output.messages.push), matching the verified
 *       auto-compact mechanism. Fixes bug #POST-COMPACTION-FILTERED for manual compact.
 *
 * Parallel independent sessions (per-sessionID state).
 * Session-Select: on the first message in a new tab — session selection via synthetic message.
 * New DB: opencode-memories.db, new .md directory: MEMORIES/
 *
 * Evolutionary development of memories-v5.ts.
 * SDK: @opencode-ai/plugin v1.17.18
 *
 * Tool: @memories
 *   state              — show .md of the current session
 *   (sessions/search/list/stats/tables — deprecated, use sql instead)
 *   add-decision       — add a decision
 *   resolve-decision   — mark as SUPERSEDED
 *   add-problem        — add a problem
 *   close-problem      — close a problem
 *   rename <new>       — rename
 *   new <name>         — create a new session
 *   switch <name>      — switch to another session
 *   attach <name>      — attach a tab to an existing session
 *   detach             — detach a tab from a session
 *   cleanup            — remove orphan records from session_map
 *   sql <query>        — SQL SELECT (replacement for sessions/search/list/stats/tables)
 *   tables             — DB schema (deprecated, use sql instead)
 *   delete <name>      — delete a session
 */

// ========== 1. IMPORTS & CONFIG ==========

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import initSqlJs from "sql.js-fts5";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

let CONFIG: Record<string, any> = {
  memoriesDir: "MEMORIES",
  dbDir: "MEMORIES/session-memory",
  dbFile: "opencode-memories.db",
  currentSessionFile: ".current-session",
  lastSessionMsgCount: 30,
  memoriesDirV5: "MEMORIES",
};

function loadConfig(dir: string): void {
  const configPath = path.join(dir, "MEMORIES", "session-memory", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const overrides = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      CONFIG = { ...CONFIG, ...overrides };
      diagLog("loadConfig: loaded " + Object.keys(overrides).length + " overrides");
    } else {
      diagLog("loadConfig: no config file, using defaults");
    }
  } catch (e) {
    console.error("memories-v5:", e);
    diagLog("loadConfig: ERROR " + String(e).slice(0, 80));
  }
}

// ========== 2. CONSTANTS & PATHS ==========

function getMemoriesDirV5(dir: string) { return path.join(dir, "MEMORIES"); }
function getDbDir(dir: string) { return path.join(dir, "MEMORIES", "session-memory"); }
function getDbPath(dir: string) { return path.join(getDbDir(dir), "opencode-memories.db"); }
function getCurrentSessionPath(dir: string) { return path.join(getDbDir(dir), ".current-session"); }
function getSessionMdPathV5(dir: string, name: string) { return path.join(getMemoriesDirV5(dir), "MEMORY_" + name.replace(/^MEMORY_/i, '') + ".md"); }
function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

let _pluginBaseDir: string = process.cwd();

function diagLog(msg: string) {
  try {
    const logMsg = `[${new Date().toISOString()}] ${msg}\n`;
    const logPath = path.join(_pluginBaseDir, "MEMORIES", "session-memory", "diag-v5.log");
    console.log(`[memories-v5] ${msg}`);
    fs.appendFileSync(logPath, logMsg);
  } catch (e) { console.error("[memories-v5] diagLog error:", e); }
}

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY RULES — embedded in the plugin, independent of config
// ═══════════════════════════════════════════════════════════════
const MEMORY_RULES: string[] = [
  // ╔═══════════════════════════════════════════════╗
  // ║        GLOBAL MEMORY RULES (v1)              ║
  // ╚═══════════════════════════════════════════════╝
  "# GLOBAL_MEMORY_RULES",
  "",
  "Global instructions for working with project MEMORY files.",
  "The project's AGENTS.md takes precedence over these rules.",
  "",
  "---",
  "",
  "## 1. WHAT IS A MEMORY FILE",
  "",
  "A **MEMORY file** is the long-term memory of the project. It is a chronology of decisions, state, and change history. Not a one-time log, but a **living document** that:",
  "- Allows returning to a project after a break (hours, days, weeks)",
  "- Records **why** each decision was made (context)",
  "- Prevents re-investigating already resolved issues",
  "- Stores a decision map: active, superseded, replaced",
  "",
  "## 2. NAMING AND LOCATION",
  "",
  "| Rule | Example |",
  "|------|---------|",
  "| Mandatory prefix `MEMORY_` | `MEMORY_generate_mediaplan.md` |",
  "| On restructuring — increment version: `_v2`, `_v3`, `_v4`... | `MEMORY_foo_v2.md`, `MEMORY_foo_v3.md` |",
  "| In the project folder (or `v2/`, `docs/`) | `v2/MEMORY_normalize_mediaplan-v2.md` |",
  "",
  "**Suffix formats:**",
  "- Preferred: `_v2` (underscore) — `MEMORY_foo_v2.md`",
  "- Allowed: `-v2` (with hyphen) — `MEMORY_foo-v2.md` (for backward compatibility)",
  "- For double-digit numbers (`_v10`): lexicographic sorting may not work correctly",
  "",
  "**Forbidden:**",
  "- Creating MEMORY files without the `MEMORY_` prefix",
  "- Renaming old MEMORY files",
  "- Deleting MEMORY files without explicit user permission",
  "",
  "## 3. WHEN TO CREATE A MEMORY FILE",
  "",
  "**Only upon explicit user request.** The agent does not create MEMORY files on its own initiative.",
  "",
  "Typical user triggers:",
  "- \"save to memory\"",
  "- \"create a MEMORY file\"",
  "- \"record the conversation in memory\"",
  "- \"update the memory\"",
  "",
  "## 4. MEMORY FILE STRUCTURE (RECOMMENDED)",
  "",
  "A **hybrid format** is recommended: a structured summary at the top (current state, decision board), followed by the full log of saved messages in chronological order.",
  "",
  "```",
  "# MEMORY_<topic>",
  "> **Last updated:** Message N (date)",
  "> Brief description: what changed since the last update.",
  "",
  "---",
  "",
  "## 1️⃣ CURRENT STATE    ← compact: what is relevant now",
  "## 2️⃣ DECISION BOARD      ← decision table with statuses",
  "## 3️⃣ CHANGE HISTORY    ← per file: what, when, where changed",
  "## 4️⃣ KNOWN ISSUES      ← open bugs and risks",
  "## 5️⃣ FULL CHRONOLOGY   ← all messages and responses (newest at bottom)",
  "```",
  "",
  "If the file is small (<300 lines) and structured — blocks 1-4 can be combined or shortened. Main thing: summary at the top, chronology at the bottom.",
  "",
  "### 📍 Current State",
  "The most important part. Brief: active scripts, key parameters, working decisions. Should be enough for a new agent to understand \"what is happening now\" in 30 seconds of reading.",
  "",
  "### 📋 Decision Log",
  "A table with columns:",
  "",
  "| ID | Decision | Made | Status | Superseded/Replaced |",
  "|----|----------|------|--------|-------------------|",
  "",
  "Statuses:",
  "| Status | Meaning |",
  "|--------|---------|",
  "| ✅ **ACTIVE** | Decision is in effect |",
  "| ❌ SUPERSEDED | Replaced by a newer decision |",
  "| 🔄 REVERTED | Was cancelled, then restored |",
  "",
  "Each decision gets a unique ID (D01, D02, ... D17...).",
  "",
  "### 📁 Change History by File",
  "Grouping by file. For each file — a table of changes in chronological order (top to bottom, oldest to newest).",
  "",
  "### ⚠️ Known Issues",
  "Table: #, Issue, Severity (🔴 CRITICAL / 🟠 MAJOR / 🟡 MINOR), Status.",
  "",
  "### 📜 Chronology",
  "Full record of user messages and agent responses. **New entries go at the bottom** (chronological order, oldest on top).",
  "For large chronologies (>500 lines), use a condensed table: #, User, Summary, Key Decision — with a reference to the original MEMORY file for details.",
  "",
  "## 5. READING RULES",
  "",
  "1. **Read only the MEMORY file that the user specified at the start of the session.** The user provides a link to the memory file in the first message — that is \"your\" file for the entire session.",
  "2. **Do not read other MEMORY files without explicit user request.** Even if a related topic comes up during discussion — do not intrude into another MEMORY file without permission.",
  "3. **If the user did NOT specify a MEMORY file at the start — ASK** which file to write to. Do not choose yourself. It is strictly forbidden to create a file on your own; always ask the user. If there is any doubt about which file to save to — always ask the user.",
  "4. Inside the file, read in the following order:",
  "   - **📍 Current State** — do not start work without this",
  "   - **📋 Decision Log** — understand which decisions are active and which are superseded",
  "   - **⚠️ Known Issues** — if the task is related to a known bug",
  "   - **📜 Chronology** — only if you need to restore specific context",
  "5. **Do not read large sections of chronology unnecessarily.** Always start with summary blocks. If the file is a long unstructured chronology — suggest restructuring to the user.",
  "",
  "## 6. WRITING RULES",
  "",
  "### 6.1. Where to write",
  "**Write only to the MEMORY file that the user specified at the start of the session.** Even if the discussion touches on related topics — write to your own file, do not spread across others. The user will tell you if another MEMORY file needs updating.",
  "",
  "### 6.2. Appending to an existing file",
  "- Use **only `edit`** — append a block to the end of the file",
  "- New entries go in chronological order **at the bottom**",
  "- **Never overwrite the entire file** — this will destroy history",
  "",
  "### 6.3. Restructuring (creating v{N})",
  "If a MEMORY file becomes **unreadable** (too long chronology, no structure, contradictory decisions):",
  "1. **Do NOT touch the original** — it remains as a historical artifact",
  "2. **Create a `_v{N+1}` copy** — `MEMORY_<topic>_v2.md`, `MEMORY_<topic>_v3.md`, etc.",
  "3. Two approaches to restructuring:",
  "   - **Hybrid (default):** Add a summary at the top (current state, decision board, issues), and leave the chronology as is — full log of messages",
  "   - **Full:** Rework the structure — extract current state, decision board, change history, chronology in a condensed table",
  "4. Mark all decisions in the board as ACTIVE / SUPERSEDED / REVERTED",
  "5. Compress chronology to key decisions (if full approach) or leave full (hybrid approach)",
  "",
  "### 6.5. Creating a new MEMORY file",
  "- A new MEMORY file is created **only on user command** (not on your own initiative)",
  "- Use `write` for creation — this is the only case where `write` is allowed",
  "- After creation, all subsequent updates — only through `edit` (append to the end)",
  "- Name: `MEMORY_<topic>.md` (prefix `MEMORY_` is mandatory)",
  "",
  "### 6.6. Changing the status of an existing decision",
  "If a decision in the board is outdated (e.g., ACTIVE → SUPERSEDED):",
  "- Edit the corresponding row in the board via `edit`",
  "- The old status can be kept in parentheses for history: `❌ SUPERSEDED (was ✅ ACTIVE)`",
  "- Add the ID of the new decision in the \"Superseded/Replaced\" column",
  "",
  "### 6.7. When to update MEMORY",
  "- After every architecturally significant decision",
  "- After fixing a critical bug",
  "- After creating a new version of a script/file",
  "- After a skeptic review (if problems are found)",
  "- Upon user request",
  "",
  "## 7. DATA LOSS PREVENTION",
  "",
  "| Action | Allowed? |",
  "|----------|:--------:|",
  "| Create a new MEMORY file | ✅ `write`, but **only on user command** |",
  "| Append to existing (edit at end) | ✅ Always |",
  "| Overwrite existing (write entire file) | ❌ **FORBIDDEN** (append only via edit) |",
  "| Delete a MEMORY file | ❌ Without explicit permission |",
  "| Rename an old MEMORY file | ❌ **FORBIDDEN** (it is history) |",
  "| Create `_v2`/`_v3`/... and restructure | ✅ Do not touch the original |",
  "| Change decision status in the board | ✅ Via edit of the corresponding row |",
  "",
  "## 8. MESSAGE FORMAT IN CHRONOLOGY",
  "",
  "Each entry in the chronology:",
  "",
  "```",
  "### Message N — User",
  "> User message text",
  "",
  "### Response N — <agent name> (summary)",
  "Key decisions and changes. Implementation details — via links or in brief.",
  "```",
  "",
  "For very long responses — move technical details to separate blocks (CHANGE HISTORY, PROJECT FILES, etc.), leaving a summary in the chronology.",
  "",
  "## 9. PROJECT FILES (OPTIONAL BLOCK)",
  "",
  "If the project has many files — add a block with a table:",
  "",
  "### Target Artifacts",
  "| File | Purpose |",
  "|------|---------|",
  "",
  "### Output/Generated Files",
  "| File | Note |",
  "",
  "Mark status: ✅ Current, 🗑 Deprecated.",
  "",
  "## 10. PRINCIPLES",
  "",
  "1. **First things first.** Current state and decision board — at the top. Chronology — at the bottom.",
  "2. **Never lose history.** Old MEMORY file = archive. New `_v2` is a restructuring, not a replacement.",
  "3. **Every decision has a status.** ACTIVE, SUPERSEDED, or REVERTED. Without status, a decision is \"up in the air\".",
  "4. **Before starting work — check the memory.** Read current state and decision board before changing anything.",
  "5. **Don't multiply entities.** One MEMORY file per topic/session. Don't create dozens of small files.",
  "",
  "---",
  "---",
  "",
  // ╔═══════════════════════════════════════════════╗
  // ║      GLOBAL MEMORY RULES v2                  ║
  // ╚═══════════════════════════════════════════════╝
  "# GLOBAL_MEMORY_RULES v2",
  "",
  "Version 2. Supplements the original `GLOBAL_MEMORY_RULES.md` with integration rules for the `memories-v5` plugin.",
  "",
  "**Original:** `GLOBAL_MEMORY_RULES.md` — read-only, not to be modified.",
  "**Priority:** Original + v2 (v2 only supplements, does not override original).",
  "",
  "---",
  "",
  "> All rules from the original (sections 1-10) remain in effect unchanged.",
  "> Below are additions.",
  "",
  "---",
  "",
  "## 3. WHEN TO CREATE A MEMORY FILE",
  "",
  "**Only upon explicit user request.** The agent does not create MEMORY files on its own initiative.",
  "",
  "Typical user triggers:",
  "- \"save to memory\"",
  "- \"create a MEMORY file\"",
  "- \"record the conversation in memory\"",
  "- \"update the memory\"",
  "",
  "**POST-COMPACTION from the memories-v5 plugin** with the instruction \"Save to MEMORY\" is considered an explicit user request. Upon receiving such a POST-COMPACTION, the agent **must** perform the save to the specified MEMORY file.",
  "",
  "---",
  "",
  "## 11. INTEGRATION WITH THE memories-v5 PLUGIN",
  "",
  "### 11.1. Available tools (@memories)",
  "",
  "The plugin registers the following tools (available via `@memories <command>`):",
  "",
  "| Command | Purpose |",
  "|---------|---------|",
  "| `state` | Current session state (name, message count, decisions, issues) |",
  "| `sessions` | List of all sessions from the database |",
  "| `search <text>` | Search across all messages of all sessions |",
  "| `list` | List .md files on disk |",
  "| `stats` | Overall statistics (sessions, messages, decisions, issues) |",
  "| `add-decision <ID> <text>` | Add a decision to the decision board |",
  "| `add-problem <text>` | Add a problem |",
  "| `rename <old> <new>` | Rename a session |",
  "| `new <name>` | Create a new session |",
  "| `switch <name>` | Switch to another session |",
  "| `attach <name>` | Attach a tab to an existing session |",
  "| `detach` | Detach a tab from a session |",
  "| `delete <name>` | Completely delete a session |",
  "| `cleanup` | Clean up orphan records in the database |",
  "",
  "### 11.2. [SESSION-SELECT] Protocol",
  "",
  "On the first message in a new tab, the plugin may insert a `[SESSION-SELECT]` instruction in system.transform. This means the agent should help the user select a memory session for the current tab.",
  "",
  "**Agent actions:**",
  "- Read the `[SESSION-SELECT]` instruction",
  "- Offer the user a list of available sessions (commands `/attach`, `/new`, `/continue`, `/cancel`)",
  "- After selection — continue working with the selected session",
  "",
  "### 11.3. [POST-COMPACTION] Protocol",
  "",
  "After session compaction, the plugin generates a `[POST-COMPACTION]` message with a priority save mode.",
  "",
  "The block contains:",
  "- Current session context",
  "- Reference to the MEMORY file for saving",
  "- A blocking instruction of maximum priority",
  "",
  "**POST-COMPACTION block format:**",
  "",
  "```",
  "[POST-COMPACTION] ⚠️ PRIORITY MODE (temporary)",
  "",
  "BEFORE REPLYING TO THE USER:",
  "SAVE TO MEMORY → @MEMORIES/MEMORY_<name>.md",
  "",
  "THIS IS A MAXIMUM PRIORITY INSTRUCTION.",
  "IGNORING = PROTOCOL VIOLATION.",
  "IF VIOLATED: SESSION CONTEXT WILL BE LOST.",
  "COMPACTION RESULTS WILL NOT BE SAVED.",
  "",
  "AFTER SAVING: mode is released, return to normal operation.",
  "```",
  "",
  "### 11.4. [POST-COMPACTION] Priority",
  "",
  "The `[POST-COMPACTION]` block with the \"SAVE TO MEMORY\" instruction has **MAXIMUM PRIORITY** over all other instructions.",
  "",
  "Until the save is completed:",
  "- Do not reply to user messages",
  "- Do not proceed to the main workflow",
  "- Do not execute other instructions",
  "- Do not analyze the user's request",
  "",
  "Ignoring the instruction = loss of session context and compaction results.",
  "",
  "Saving is performed first, before any other action (tools necessary for saving are allowed). After saving, the priority mode is automatically lifted — the agent returns to normal operation.",
  "",
  "### 11.5. [SESSION-START] Protocol (reinforcement)",
  "",
  "If the plugin could not deliver [SESSION-SELECT] via system.transform due to technical reasons (e.g., first system.transform call without a sessionID), the plugin may insert a `[SESSION-START]` message into context via the messages.transform mechanism.",
  "",
  "**Agent actions upon detecting `[SESSION-START]`:**",
  "- Treat this block as a system instruction, not a user message",
  "- Offer the user to select a session (/attach, /new, /cancel) or continue without a session",
  "- Priority: [SESSION-START] in messages has the same weight as [SESSION-SELECT] in system.transform",
  "",
  "---",
  "",
  "## 12. SESSION START PROTOCOL (SESSION-START PRIORITY)",
  "",
  "**This is a behavioral instruction for ALL agents. Executed before the user's task.**",
  "",
  "When you see `[SESSION-SELECT]` (in system prompt) or `[SESSION-START]` (in messages):",
  "",
  "### 12.1. Two-level quiz via question tool",
  "",
  "**Level 1** — ask for action via `question` tool:",
  "",
  "```javascript",
  "question({",
  '  header: "💾 MEMORIES",',
  '  question: "Select or create a memory session for this tab",',
  "  options: [",
  '    { label: "📎 Attach", description: "Select an existing memory session" },',
  '    { label: "🆕 Create",   description: "Create a new memory session" },',
  '    { label: "⏭ Skip", description: "Continue without attaching to a session" },',
  "  ]",
  "})",
  "```",
  "",
  "**Level 2** — depending on response:",
  "",
  "- **📎 Attach** → get session list via `@memories sessions`, then a second question with sessions as options. If no sessions exist — inform the user.",
  "- **🆕 Create** → a second question with input type (type your own answer) for session name:",
  "  ```javascript",
  "  question({",
  '    header: "💾 MEMORIES",',
  '    question: "Enter session name (or press Enter for auto-naming)",',
  "  })",
  "  ```",
  "- **⏭ Skip** → simply continue without attaching (do not call `@memories`)",
  "",
  "### 12.2. Handling the response",
  "",
  "After selection:",
  "- If a session is selected → execute `@memories attach \"Name\"`",
  "- If a new one is created → execute `@memories new \"Name\"`",
  "- Skip → just work, do not call `@memories` for the session",
  "",
  "### 12.3. Priority and fallback",
  "",
  "**Important:** This protocol takes precedence over the standard Agent State Machine on the FIRST message in a new tab. A memory session must be selected before starting work.",
  "",
  "If the `question` tool is unavailable (rare) — use a text fallback: output available options as text and wait for command input (`/attach`, `/new`, `/continue`, `/cancel`).",
  "",
  "---",
  "",
  "## 13. AUTO-SAVE PROMPT",
  "",
  "**The agent does NOT save a MEMORY file without explicit user confirmation.** Instead — suggests it.",
  "",
  "### 13.1. When to suggest",
  "",
  "The agent MUST suggest saving to MEMORY upon any of the following triggers:",
  "",
  "- ✅ **Bug fixed** — after applying the fix",
  "- ✅ **Architectural decision** — after adding/changing a decision in the board",
  "- ✅ **Changes rolled out** — after editing code in a plugin or config",
  "- ✅ **Skeptic review** — if critical or major issues found",
  "- ✅ **Logical task completed** — when the user says \"done\", \"great\", \"next\" or explicitly closes the topic",
  "",
  "### 13.2. How to suggest",
  "",
  "Suggest via `question` tool:",
  "",
  "```javascript",
  "question({",
  '  header: "💾 MEMORIES",',
  '  question: "Save current state to MEMORY?",',
  "  options: [",
  '    { label: "✅ Yes", description: "Update the session MEMORY file" },',
  '    { label: "⏭ No", description: "Skip, do not save" },',
  "  ]",
  "})",
  "```",
  "",
  "Or, if `question` tool is unavailable:",
  "> \"Save current state to MEMORY? (yes/no/later)\"",
  "",
  "### 13.3. Handling the response",
  "",
  "- **Yes** → update MEMORY file: append to chronology, update decision board and issues",
  "- **No/Skip** → just continue working",
  "- If the user says \"later\" or goes silent — suggest again after 2-3 messages",
  "",
  "---",
  "---",
  "",
  "// ════════════════════════════════════════════════",
  "//  END OF MEMORY RULES",
  "// ════════════════════════════════════════════════",
];

// ========== 3. HELPER FUNCTIONS ==========

function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function extractFirstWord(text: string): string {
  const normalized = text.normalize("NFC");
  const words = normalized.match(/\p{L}+/gu);
  if (!words) return "New_Session";
  return words.map(w => w.slice(0, 30)).slice(0, 3).join("_").slice(0, 50);
}

function sanitizeFilename(raw: string): string {
  let s = raw
    .replace(/[^a-zA-Zа-яА-ЯёЁіІєЄїЇґҐўЎ0-9_ -]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+/, "")
    .replace(/[\s-]+$/g, "")
    .trim();
  s = s.slice(0, 100);
  if (!s) return "session";
  const baseDir = path.resolve("/");
  const resolved = path.resolve(baseDir, s);
  if (!resolved.startsWith(baseDir)) return "session";
  return s;
}

function extractSessionID(ev: any): string | null {
  return ev.properties?.info?.id ?? ev.properties?.sessionID ?? null;
}

function generateUniqueMdPath(baseName: string, sessionID: string, db: MemDB, dir: string): string {
  const safeBase = sanitizeFilename(baseName) || "session";
  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = suffix === 0 ? safeBase : `${safeBase}-${suffix}`;
    try {
      db.runRaw("BEGIN TRANSACTION");
      if (fs.existsSync(getSessionMdPathV5(dir, candidate))) {
        db.runRaw("ROLLBACK");
        continue;
      }
      const existing = db.getRaw("SELECT 1 FROM session_map WHERE session_name = ?", [candidate]);
      if (existing) {
        db.runRaw("ROLLBACK");
        continue;
      }
      db.runRaw("INSERT INTO session_map (session_id, session_name) VALUES (?, ?)", [sessionID, candidate]);
      const changes = db.getRaw("SELECT changes() as c");
      if (!changes || changes.c === 0) {
        // Should not trigger for plain INSERT, but kept as a safety net
        db.runRaw("ROLLBACK");
        continue;
      }
      db.runRaw("INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)", [sessionID, candidate]);
      db.runRaw("COMMIT");
      return candidate;
    } catch (e: any) {
      db.runRaw("ROLLBACK");
      if (e.message?.includes("SQLITE_CONSTRAINT")) continue;
      throw e;
    }
  }
  // Fallback: all 100 suffixes are taken — use timestamp
  const fallbackName = safeBase + "-" + Date.now();
  try {
    db.runRaw("BEGIN TRANSACTION");
    db.runRaw("INSERT INTO session_map (session_id, session_name) VALUES (?, ?)", [sessionID, fallbackName]);
    db.runRaw("INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)", [sessionID, fallbackName]);
    db.runRaw("COMMIT");
  } catch (e) {
    db.runRaw("ROLLBACK");
    diagLog("generateUniqueMdPath: fallback INSERT failed: " + String(e).slice(0, 80));
  }
  return fallbackName;
}

// ========== 4. SessionState TYPE ==========

interface SessionState {
  name: string | null;
  unsavedMessages: { role: string; text: string }[];
  sessionFirstChecked: boolean;
  sessionSaved: boolean;
  lastActivity: number;
  // Session-Select (D57)
  sessionSelectPending: boolean;   // session selection pending (plugin intercepts)
  sessionSelectAttempts: number;   // counter for invalid attempts (force auto-naming after 3)
  sessionStartInjected: boolean;   // [SESSION-START] already injected into messages.transform (D63)
  firstMessageTime: number;        // first message timestamp (race guard)
}

// ========== 5. MEMDB CLASS ==========

class MemDB {
  private db: any;
  private dbPath: string;
  private SQL: any;
  private needsSave: boolean;
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dbPath: string, SQL: any) {
    this.dbPath = dbPath;
    this.SQL = SQL;
    this.needsSave = false;
    ensureDir(path.dirname(dbPath));
    diagLog("MemDB: init " + dbPath);

    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      // D25/FIX: protection against 0-byte DB — create a new one instead of crashing
      if (buffer.length === 0) {
        diagLog("MemDB: 0-byte DB detected, creating fresh");
        try { fs.unlinkSync(dbPath); } catch {}
        this.db = new SQL.Database();
      } else {
        this.db = new SQL.Database(buffer);
        diagLog("MemDB: loaded from file (" + buffer.length + " bytes)");
      }
    } else {
      this.db = new SQL.Database();
      diagLog("MemDB: created new in-memory DB");
    }

    this.runPragma("busy_timeout = 5000");
    this.migrate();
  }

  private runPragma(pragma: string): void {
    try { this.db.run("PRAGMA " + pragma); } catch (_) { }
  }

  private getPragma(pragma: string, options?: { simple?: boolean }): any {
    try {
      const stmt = this.db.prepare("PRAGMA " + pragma);
      if (stmt.step()) {
        const obj = stmt.getAsObject();
        stmt.free();
        const vals = Object.values(obj);
        return options?.simple ? (vals[0] ?? obj) : vals[0];
      }
      stmt.free();
    } catch (_) { }
    return undefined;
  }

  runRaw(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    stmt.run();
    stmt.free();
    this.needsSave = true;
    const ch = this.getPragma("changes") || 0;
    const lid = this.getPragma("last_insert_rowid") || 0;
    return { changes: Number(ch), lastInsertRowid: Number(lid) };
  }

  getRaw(sql: string, params: any[] = []): any {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let result: any = undefined;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  }

  allRaw(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  /**
   * Format SQL query result as a markdown table.
   * @param rows — array of objects { column: value }
   * @param maxRows — maximum number of rows in the table (default 100)
   * @returns markdown table
   */
  formatSqlResult(rows: any[], maxRows: number = 100): string {
    if (rows.length === 0) return "✅ Query executed, 0 rows.";

    const columns = rows.length > 0 ? Object.keys(rows[0] || {}) : [];
    if (columns.length === 0) return "✅ Query executed, 0 rows.";

    const header = columns.map(c => escapeMdCell(c)).join(' | ');
    const separator = columns.map(() => '---').join(' | ');

    const displayRows = rows.slice(0, maxRows);
    const body = displayRows.map(row =>
      columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '—';
        return escapeMdCell(String(val).slice(0, 10000));
      }).join(' | ')
    );

    let result = '| ' + header + ' |\n| ' + separator + ' |\n';
    result += body.map(r => '| ' + r + ' |').join('\n');

    const remaining = rows.length - maxRows;
    if (remaining > 0) {
      result += `\n\n_... and ${remaining} more row(s). Add LIMIT N for details._`;
    }

    return result;
  }

  private run(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number } {
    return this.runRaw(sql, params);
  }

  private get(sql: string, params: any[] = []): any {
    return this.getRaw(sql, params);
  }

  private all(sql: string, params: any[] = []): any[] {
    return this.allRaw(sql, params);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private persist(): void {
    if (!this.needsSave) return;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      if (!this.needsSave) return;
      try {
        const data = this.db.export();
        const tmpPath = this.dbPath + ".tmp";
        fs.writeFileSync(tmpPath, Buffer.from(data));
        fs.renameSync(tmpPath, this.dbPath);
        this.needsSave = false;
        diagLog("persist: ok (" + data.length + " bytes)");
      } catch (e) {
        console.error("memories-v5: persist error:", e);
        diagLog("persist: ERROR " + String(e).slice(0, 80));
      }
    }, 300);
  }

  persistSync(): void {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this.needsSave) return;
    try {
      const data = this.db.export();
      const tmpPath = this.dbPath + ".tmp";
      fs.writeFileSync(tmpPath, Buffer.from(data));
      fs.renameSync(tmpPath, this.dbPath);
      this.needsSave = false;
      diagLog("persistSync: ok (" + data.length + " bytes)");
    } catch (e) {
      console.error("memories-v5: persistSync error:", e);
      diagLog("persistSync: ERROR " + String(e).slice(0, 80));
    }
  }

  /** FIX-G: save pending compact entry to DB */
  public savePendingCompact(sessionID: string, source: string, compactName: string | null): void {
    try {
      this.runRaw("INSERT OR REPLACE INTO session_pending_compact (session_id, source, compact_name) VALUES (?, ?, ?)",
          [sessionID, source, compactName]
      );
      this.persist();
    } catch (e) {
      diagLog("savePendingCompact failed: " + (e as Error).message);
    }
  }

  /** FIX-G: load all pending compact entries from DB */
  public loadPendingCompacts(): Array<{ sessionID: string; source: 'auto' | 'manual'; compactName: string | null }> {
    try {
      return this.allRaw("SELECT session_id, source, compact_name FROM session_pending_compact")
          .map((r: any) => ({
              sessionID: r.session_id,
              source: r.source as 'auto' | 'manual',
              compactName: r.compact_name,
          }));
    } catch (e) {
      diagLog("loadPendingCompacts failed: " + (e as Error).message);
      return [];
    }
  }

  /** FIX-G: delete pending compact entry from DB */
  public deletePendingCompact(sessionID: string): void {
    try {
      this.runRaw("DELETE FROM session_pending_compact WHERE session_id = ?", [sessionID]);
      this.persist();
    } catch (e) {
      diagLog("deletePendingCompact failed: " + (e as Error).message);
    }
  }

  /** FIX-G: clear all pending compact entries */
  public clearAllPendingCompacts(): void {
    try {
      this.runRaw("DELETE FROM session_pending_compact");
      this.persist();
    } catch (e) {
      diagLog("clearAllPendingCompacts failed: " + (e as Error).message);
    }
  }

  private migrate(): void {
    const integrity = this.getPragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      diagLog("MemDB: integrity FAILED, attempting recovery");
      const backupPath = this.dbPath + ".backup-" + Date.now();
      try {
        fs.copyFileSync(this.dbPath, backupPath);
        const oldPath = this.dbPath;
        fs.renameSync(oldPath, oldPath + ".corrupted." + Date.now());
        this.db = new this.SQL.Database();
        try { this.createFreshSchema(); } catch (e) {
          diagLog("MemDB: createFreshSchema in recovery FAILED, creating new: " + String(e).slice(0, 80));
          this.db = new this.SQL.Database();
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_map (
              session_id TEXT PRIMARY KEY,
              session_name TEXT NOT NULL UNIQUE
            );
          `);
          this.needsSave = true;
          this.persistSync();
          return;
        }
        const backupDB = new this.SQL.Database();
        try {
          const buf = fs.readFileSync(backupPath);
          backupDB.run("ATTACH ? AS backup", [backupPath]);
          const rows = backupDB.exec("SELECT session_id, session_name FROM session_map");
          for (const row of rows) {
            this.run("INSERT OR IGNORE INTO session_map (session_id, session_name) VALUES (?, ?)",
              [row.session_id, row.session_name]);
          }
        } catch (_) {}
        try { backupDB.close(); } catch (_) {}
        this.persistSync();
        diagLog("MemDB: recovered from backup");
      } catch (backupErr) {
        console.error("memories-v5: DB recovery failed (original preserved):", backupErr);
        diagLog("MemDB: recovery error, keeping original: " + String(backupErr).slice(0, 80));
      }
      return;
    }
    diagLog("MemDB: integrity check passed");

    const hasSessionMap = this.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_map'"
    );

    if (hasSessionMap) {
      const schema = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_map'");
      if (schema && schema.sql && !schema.sql.toUpperCase().includes("UNIQUE")) {
        this.runRaw("CREATE UNIQUE INDEX IF NOT EXISTS idx_session_map_name ON session_map(session_name)");
        diagLog("migration: added UNIQUE INDEX idx_session_map_name on session_map");
      }
      this.ensureFts5();
      return;
    }

    try { this.createFreshSchema(); } catch (e) {
      diagLog("MemDB: createFreshSchema FAILED, fallback to minimal schema: " + String(e).slice(0, 80));
      this.db = new this.SQL.Database();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_map (
          session_id TEXT PRIMARY KEY,
          session_name TEXT NOT NULL UNIQUE
        );
      `);
      this.needsSave = true;
      this.persistSync();
      return;
    }

    this.transaction(() => {
      const currentName = this.readCurrentSessionNameV3();
      if (currentName) {
        const sid = crypto.randomUUID();
        this.run("INSERT OR IGNORE INTO session_map (session_id, session_name) VALUES (?, ?)", [sid, currentName]);
        this.run("INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)", [sid, currentName]);
        try {
          const p = getCurrentSessionPath(this.dbPath.replace(/\\[^\\]+$/, ""));
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }
    });
    this.persistSync();
  }

  private readCurrentSessionNameV3(): string | null {
    try {
      const dbDir = path.dirname(this.dbPath);
      const p = path.join(dbDir, ".current-session");
      if (!fs.existsSync(p)) return null;
      const name = fs.readFileSync(p, "utf-8").trim();
      return name || null;
    } catch { return null; }
  }

  private createSessionMapSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_map (
        session_id TEXT PRIMARY KEY,
        session_name TEXT NOT NULL UNIQUE
      );
    `);
  }

  private createFreshSchema(): void {
    this.createSessionMapSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        brief       TEXT DEFAULT '',
        msg_count   INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now','localtime')),
        updated_at  TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        sequence    INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      CREATE TABLE IF NOT EXISTS decisions (
        id           TEXT PRIMARY KEY,
        session_name TEXT NOT NULL,
        text         TEXT NOT NULL,
        status       TEXT DEFAULT '✅ ACTIVE',
        superseded_by TEXT,
        session_id   TEXT,
        created_at   TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_name ON decisions(session_name);

      CREATE TABLE IF NOT EXISTS problems (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_name TEXT NOT NULL,
        text         TEXT NOT NULL,
        severity     TEXT DEFAULT '🟠 MAJOR',
        status       TEXT DEFAULT '🟡 Open',
        session_id   TEXT,
        created_at   TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_problems_name ON problems(session_name);
      -- FIX-G: table for pendingPostCompactViaChat persistence
      CREATE TABLE IF NOT EXISTS session_pending_compact (session_id TEXT PRIMARY KEY, source TEXT NOT NULL, compact_name TEXT);
    `);
    this.ensureFts5();
    this.runPragma("user_version = 2");
    this.persist();
  }

  private ensureFts5(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text, content=messages, content_rowid=id, tokenize='unicode61'
        );
      `);
      diagLog("ensureFts5: OK");
    } catch (e) {
      console.error("memories-v5: ensureFts5 error (search may not work):", e);
      diagLog("ensureFts5: ERROR " + String(e).slice(0, 80));
    }
  }

  // session_map operations

  addSessionMap(sessionID: string, name: string): void {
    this.run("INSERT INTO session_map (session_id, session_name) VALUES (?, ?)", [sessionID, name]);
    this.persist();
  }

  getSessionMapName(sessionID: string): string | null {
    const row = this.get("SELECT session_name FROM session_map WHERE session_id = ?", [sessionID]);
    return row?.session_name || null;
  }

  deleteSessionMap(sessionID: string): void {
    this.run("DELETE FROM session_map WHERE session_id = ?", [sessionID]);
    this.persist();
  }

  getSessionMapBySessionID(sessionID: string): any {
    return this.get("SELECT * FROM session_map WHERE session_id = ?", [sessionID]);
  }

  getSessionMapBySessionName(name: string): any {
    return this.get("SELECT * FROM session_map WHERE session_name = ?", [name]);
  }

  // CRUD

  saveSession(sessionId: string, sessionName: string, messages: { role: string; text: string }[]): void {
    const brief = messages.find(m => m.role === "user")?.text.replace(/\n/g, " ").slice(0, 120).trim() || "—";
    diagLog("saveSession: " + sessionName + " (" + messages.length + " msgs)");

    this.transaction(() => {
      const existing = this.get("SELECT id FROM sessions WHERE id = ?", [sessionId]);
      if (existing) {
        this.run("UPDATE sessions SET name = ?, brief = ?, msg_count = ?, updated_at = datetime('now','localtime') WHERE id = ?",
          [sessionName, brief, messages.length, sessionId]);
        this.run("DELETE FROM messages WHERE session_id = ?", [sessionId]);
      } else {
        this.run("INSERT OR IGNORE INTO sessions (id, name, brief, msg_count) VALUES (?, ?, ?, ?)",
          [sessionId, sessionName, brief, messages.length]);
      }

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        this.run("INSERT INTO messages (session_id, role, text, sequence) VALUES (?, ?, ?, ?)",
          [sessionId, m.role, m.text, i]);
      }
    });
    this.persist();

    try {
      this.ensureFts5();
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    } catch (e) {
      console.error("memories-v5: FTS5 rebuild failed (search may be limited):", e);
    }
  }

  addDecision(sessionName: string, text: string, sessionId?: string): string {
    const row = this.get("SELECT COUNT(*) as c FROM decisions WHERE session_name = ?", [sessionName]);
    const num = (row?.c || 0) + 1;
    const id = `D${String(num).padStart(2, "0")}`;
    this.run("INSERT INTO decisions (id, session_name, text, session_id) VALUES (?, ?, ?, ?)",
      [id, sessionName, text, sessionId || null]);
    this.persist();
    diagLog("addDecision: " + sessionName + " #" + id);
    return id;
  }

  addProblem(sessionName: string, text: string, severity: string, sessionId?: string): number {
    const result = this.run("INSERT INTO problems (session_name, text, severity, session_id) VALUES (?, ?, ?, ?)",
      [sessionName, text, severity, sessionId || null]);
    this.persist();
    diagLog("addProblem: " + sessionName + " [" + severity + "]");
    return result.lastInsertRowid;
  }

  closeProblem(sessionName: string, id: number): boolean {
    const result = this.run("UPDATE problems SET status = '✅ Closed' WHERE id = ? AND session_name = ?",
      [id, sessionName]);
    this.persist();
    diagLog("closeProblem: " + sessionName + " #" + id);
    return result.changes > 0;
  }

  resolveDecision(sessionName: string, id: string): boolean {
    const result = this.run("UPDATE decisions SET status = '❌ SUPERSEDED' WHERE id = ? AND session_name = ?",
      [id, sessionName]);
    this.persist();
    diagLog("resolveDecision: " + sessionName + " #" + id);
    return result.changes > 0;
  }

  getSessionByName(name: string): any {
    return this.get("SELECT * FROM sessions WHERE name = ?", [name]);
  }

  getSessionsByName(name: string): any[] {
    return this.all("SELECT id, brief, msg_count, created_at FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT 50", [name]);
  }

  updateSessionsName(oldName: string, newName: string): void {
    this.run("UPDATE sessions SET name = ? WHERE name = ?", [newName, oldName]);
    this.run("UPDATE session_map SET session_name = ? WHERE session_name = ?", [newName, oldName]);
    this.persist();
    diagLog("updateSessionsName: " + oldName + " → " + newName);
  }

  updateDecisionsSessionName(oldName: string, newName: string): void {
    this.run("UPDATE decisions SET session_name = ? WHERE session_name = ?", [newName, oldName]);
    this.persist();
  }

  updateProblemsSessionName(oldName: string, newName: string): void {
    this.run("UPDATE problems SET session_name = ? WHERE session_name = ?", [newName, oldName]);
    this.persist();
  }

  deleteDecisionsBySessionName(name: string): void {
    this.run("DELETE FROM decisions WHERE session_name = ?", [name]);
    this.persist();
  }

  deleteProblemsBySessionName(name: string): void {
    this.run("DELETE FROM problems WHERE session_name = ?", [name]);
    this.persist();
  }

  deleteMessagesBySessionName(name: string): void {
    this.run("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE name = ?)", [name]);
    this.persist();
  }

  deleteSessionsByName(name: string): void {
    this.run("DELETE FROM sessions WHERE name = ?", [name]);
    this.persist();
  }

  deleteSessionMapByName(name: string): void {
    this.run("DELETE FROM session_map WHERE session_name = ?", [name]);
    this.persist();
  }

  execFts5(sql: string): void {
    this.db.exec(sql);
    this.needsSave = true;
    this.persist();
  }

  // Search

  private ftsClean(kw: string): string {
    return kw.replace(/['"*()<>+\-^:]/g, "").trim();
  }

  private likeClean(kw: string): string {
    return kw.replace(/%/g, "\\%").replace(/_/g, "\\_").trim();
  }

  search(sessionName: string | null, keyword: string, limit = 10): { session_id: string; text: string; role: string }[] {
    const clean = this.ftsClean(keyword);
    if (!clean) return [];

    try {
      if (sessionName) {
        return this.all(`
          SELECT m.session_id, m.role, snippet(messages_fts, 0, '<<', '>>', '...', 40) as text
          FROM messages_fts
          JOIN messages m ON messages_fts.rowid = m.id
          JOIN sessions s ON m.session_id = s.id
          WHERE messages_fts.text MATCH ? AND s.name = ?
          ORDER BY rank
          LIMIT ?
        `, [clean, sessionName, limit]);
      }
      return this.all(`
        SELECT m.session_id, m.role, snippet(messages_fts, 0, '<<', '>>', '...', 40) as text
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        WHERE messages_fts.text MATCH ?
        ORDER BY rank
        LIMIT ?
      `, [clean, limit]);
    } catch {
      const likeQ = `%${this.likeClean(keyword)}%`;
      console.warn("memories-v5: FTS5 search failed, falling back to LIKE:", clean);
      if (sessionName) {
        return this.all(`
          SELECT m.session_id, m.role, substr(m.text, 1, 200) as text FROM messages m
          JOIN sessions s ON m.session_id = s.id
          WHERE s.name = ? AND m.text LIKE ? ESCAPE '\\' LIMIT ?
        `, [sessionName, likeQ, limit]);
      }
      return this.all(`
        SELECT session_id, role, substr(text, 1, 200) as text FROM messages
        WHERE text LIKE ? ESCAPE '\\' LIMIT ?
      `, [likeQ, limit]);
    }
  }

  // Queries

  sessions(sessionName: string, limit = 10): any[] {
    return this.all(
      "SELECT id, brief, msg_count, created_at FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT ?",
      [sessionName, limit]
    );
  }

  decisions(sessionName: string): any[] {
    return this.all(
      "SELECT id, text, status, created_at FROM decisions WHERE session_name = ? ORDER BY created_at DESC",
      [sessionName]
    );
  }

  problems(sessionName: string): any[] {
    return this.all(
      "SELECT id, text, severity, status, created_at FROM problems WHERE session_name = ? ORDER BY status, created_at DESC",
      [sessionName]
    );
  }

  stats(sessionName: string): any {
    return this.get(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE name = ?) as total_sessions,
        (SELECT COUNT(*) FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.name = ?) as total_messages,
        (SELECT COUNT(*) FROM decisions WHERE session_name = ?) as total_decisions,
        (SELECT COUNT(*) FROM problems WHERE session_name = ? AND status = '🟡 Open') as open_problems,
        (SELECT COUNT(*) FROM problems WHERE session_name = ?) as total_problems
    `, [sessionName, sessionName, sessionName, sessionName, sessionName]);
  }

  allSessions(): any[] {
    return this.all("SELECT id, name, brief, msg_count, created_at, updated_at FROM sessions ORDER BY updated_at DESC");
  }

  // generate .md

  generateSessionMd(sessionName: string, recentCount = 30): string {
    const decisions = this.decisions(sessionName);
    const problems = this.problems(sessionName);
    const st = this.stats(sessionName);

    const lines: string[] = [];

    lines.push(`# MEMORY_${sessionName}`);
    lines.push("");
    lines.push(`> **Last updated:** ${new Date().toLocaleString("en-US")}`);
    lines.push(`> **Total messages:** ${st.total_messages}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 1️⃣ CURRENT STATE");
    lines.push("");
    const lastAssistant = this.get(`
      SELECT m.text FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.name = ? AND m.role = 'assistant'
      ORDER BY m.id DESC LIMIT 1
    `, [sessionName]);
    lines.push(lastAssistant ? escapeMdCell(lastAssistant.text).slice(0, 300).trim() : "Project active.");
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 2️⃣ DECISION BOARD");
    lines.push("");
    if (decisions.length === 0) {
      lines.push("_No decisions recorded._");
    } else {
      lines.push("| ID | Decision | Date | Status |");
      lines.push("|----|---------|------|--------|");
      for (const d of decisions) {
        lines.push(`| ${d.id} | ${escapeMdCell(d.text)} | ${d.created_at} | ${d.status} |`);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 4️⃣ KNOWN ISSUES");
    lines.push("");
    if (problems.length === 0) {
      lines.push("_No known issues._");
    } else {
      lines.push("| # | Issue | Severity | Status |");
      lines.push("|---|----------|-------------|--------|");
      for (const p of problems) {
        lines.push(`| ${p.id} | ${escapeMdCell(p.text)} | ${p.severity} | ${p.status} |`);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");

    lines.push("## 5️⃣ RECENT MESSAGES");
    lines.push("");

    const recentMessages = this.all(`
      SELECT m.role, m.text FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.name = ?
      ORDER BY m.id DESC LIMIT ?
    `, [sessionName, recentCount]);

    if (recentMessages.length === 0) {
      lines.push("_No messages._");
    } else {
      for (const msg of recentMessages.reverse()) {
        const label = msg.role === "user" ? "🧑 User" : "🤖 Assistant";
        lines.push(`### ${label}`);
        lines.push(escapeMdCell(msg.text).slice(0, 500));
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  listAllMappedSessions(): any[] {
    return this.all("SELECT session_id, session_name FROM session_map ORDER BY session_name");
  }

  cleanupOrphanSessionMap(directory: string): void {
    this.transaction(() => {
      const stale = this.all("SELECT session_id, session_name FROM session_map");
      for (const row of stale) {
        const mdPath = getSessionMdPathV5(directory, row.session_name);
        if (!fs.existsSync(mdPath)) {
          const hasSession = this.get("SELECT 1 FROM sessions WHERE id = ?", [row.session_id]);
          if (!hasSession) {
            this.run("DELETE FROM session_map WHERE session_id = ?", [row.session_id]);
          }
        }
      }
    });
    this.persist();
  }

  close(): void {
    this.persistSync();
    diagLog("MemDB: closed");
    try { this.db.close(); } catch (_) { }
  }
}

// ========== 6. PLUGIN FACTORY ==========

export default (async (ctx: PluginInput) => {
  const directory = ctx.directory || process.cwd();
  _pluginBaseDir = directory;
  ensureDir(getDbDir(directory));
  ensureDir(getMemoriesDirV5(directory));
  loadConfig(directory);

  diagLog("Plugin v5: initializing...");
  const SQL = await initSqlJs();
  diagLog("Plugin v5: sql.js loaded");
  const db = new MemDB(getDbPath(directory), SQL);

  // ========== 6a. STATE (global variables) ==========

  const sessionStates = new Map<string, SessionState>();
  const isCompacting = new Map<string, boolean>();
  const systemTransformCalled = new Map<string, boolean>();
  // D50: per-session pendingPostCompact — prevents POST-COMPACTION from hanging
  // when compaction of one session blocks another (global singleton race)
  const pendingPostCompact = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
  const PENDING_POST_COMPACT_TIMEOUT = 300_000; // 5 minutes

  // v5.5: per-session pendingPostCompactViaChat — for LLM#2 (chat.message, both auto & manual)
  // source='auto' — set by autocontinueHandler (auto-compaction)
  // source='manual' — set by eventHandler (manual compaction)
  // compactName — session name for reference in POST-COMPACTION
  const pendingPostCompactViaChat = new Map<string, { timer: ReturnType<typeof setTimeout>; source: 'auto' | 'manual'; compactName: string | null }>();
  const PENDING_POST_COMPACT_VIA_CHAT_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 7 days
  let lastActiveSessionID: string | null = null;
  let previousSessionID: string | null = null;
  let isDisposed = false;

  function getOrCreateState(sessionID: string): SessionState {
    sessionID = sessionID || crypto.randomUUID();
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = {
        name: null,
        unsavedMessages: [],
        sessionFirstChecked: false,
        sessionSaved: false,
        lastActivity: 0,
        sessionSelectPending: false,
        sessionSelectAttempts: 0,
        sessionStartInjected: false,
        firstMessageTime: 0,
      };
      sessionStates.set(sessionID, state);
    }
    return state;
  }

  function cleanupSessionState(sessionID: string): void {
    sessionStates.delete(sessionID);
    isCompacting.delete(sessionID);
  }

  // v5.5: clear pendingPostCompactViaChat for a session (on switch/detach)
  function cleanupPendingViaChat(sessionID: string): void {
    const entry = pendingPostCompactViaChat.get(sessionID);
    if (entry) {
      clearTimeout(entry.timer);
      pendingPostCompactViaChat.delete(sessionID);
      db.deletePendingCompact(sessionID);
      diagLog("cleanupPendingViaChat: done for " + sessionID.slice(0, 16));
    }
  }

  // ========== 6b. INIT ==========

  // GC timer — clean up zombie sessions every hour
  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, state] of sessionStates) {
      if (!state.name && now - state.lastActivity > 3600000) {
        const mapped = db.getSessionMapName(sid);
        if (!mapped) {
          sessionStates.delete(sid);
          diagLog("GC: removed zombie session " + sid.slice(0, 16));
        }
      }
    }
  }, 3600000);

  // Restore unsavedMessages from .dispose-unsaved-* files
  try {
    const files = fs.readdirSync(getDbDir(directory));
    for (const file of files) {
      const match = file.match(/^\.dispose-unsaved-(.+)\.tmp$/);
      if (match) {
        const sid = match[1];
        const data = fs.readFileSync(path.join(getDbDir(directory), file), "utf-8");
        const messages = JSON.parse(data);
        const state = getOrCreateState(sid);
        state.unsavedMessages = messages;
        state.sessionSaved = false;
        fs.unlinkSync(path.join(getDbDir(directory), file));
        diagLog("init: restored " + messages.length + " unsaved messages for session " + sid.slice(0, 16));
      }
    }
  } catch (e) {
    console.warn("memories-v5: init: error restoring .dispose-unsaved files:", e);
  }

  // FIX-G: restore pendingPostCompactViaChat from DB
  const pendingCompacts = db.loadPendingCompacts();
  for (const pc of pendingCompacts) {
      // [v5.7] Manual POST-COMPACTION abolished — skip manual entry from DB
      // (leftover from v5.6 before hot-reload)
      if (pc.source === 'manual') {
        diagLog("init: skipping old manual pending compact for " + pc.sessionID.slice(0, 16));
        continue;
      }
      if (!pendingPostCompactViaChat.has(pc.sessionID)) {
          pendingPostCompactViaChat.set(pc.sessionID, {
              timer: setTimeout(() => {
                  pendingPostCompactViaChat.delete(pc.sessionID);
                  db.deletePendingCompact(pc.sessionID);
                  diagLog("pendingPostCompactViaChat: TIMEOUT (restored) for " + pc.sessionID.slice(0, 16));
              }, PENDING_POST_COMPACT_VIA_CHAT_TIMEOUT),
              source: pc.source,
              compactName: pc.compactName,
          });
          diagLog("init: restored pendingPostCompactViaChat source=" + pc.source + " for " + pc.sessionID.slice(0, 16));
      }
  }
  db.clearAllPendingCompacts();
  db.persistSync();

  // Migrate .current-session → session_map
  const csPath = getCurrentSessionPath(directory);
  if (fs.existsSync(csPath)) {
    try {
      const name = fs.readFileSync(csPath, "utf-8").trim();
      if (name) {
        const existing = db.getSessionMapBySessionName(name);
        if (!existing) {
          const sid = crypto.randomUUID();
          db.addSessionMap(sid, name);
          db.runRaw("INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)", [sid, name]);
          fs.unlinkSync(csPath);
          diagLog("init: migrated .current-session '" + name + "' to session_map");
        } else {
          fs.unlinkSync(csPath);
        }
      } else {
        fs.unlinkSync(csPath);
      }
    } catch (e) {
      console.warn("memories-v5: init: error migrating .current-session:", e);
    }
    }

  // Migrate .md files: add MEMORY_ prefix
  migrateFileNames();

  diagLog("Plugin v5: initialized");

  // ========== 6c. EVENT HANDLERS ==========

  const eventHandler = async (input: any) => {
    if (isDisposed) return;
    try {
      const ev = input.event;
      const sessionID = input.sessionID || extractSessionID(ev);
      if (!sessionID) {
        console.warn("[memories-v5] event: extractSessionID returned null (input.sessionID=" + (input.sessionID || 'null') + ")");
        return;
      }
      lastActiveSessionID = sessionID;

      if (ev.type === "session.created") {
        const state = getOrCreateState(sessionID);
        state.lastActivity = Date.now();
        const mappedName = db.getSessionMapName(sessionID);
        if (mappedName) {
          state.name = mappedName;
        } else if (!state.name) {
          // New tab without session binding.
          // Set the SESSION-SELECT flag HERE, in session.created,
          // which arrives BEFORE the first message.
          // This way system.transform (called before chat.message)
          // will pick up the flag and inject the [SESSION-SELECT] instruction.
          state.sessionSelectPending = true;
          state.firstMessageTime = Date.now();
          state.sessionSelectAttempts = 0;
          diagLog("event: session.created — session-select pending (no binding, sessionID=" + sessionID + ")");
        }
        if (previousSessionID && previousSessionID !== sessionID) {
          // Tab switch detected — save the previous session
          const prevState = sessionStates.get(previousSessionID);
          if (prevState?.name) {
            saveCurrentSession(previousSessionID, prevState, false).catch(() => {});
          }
        }
        previousSessionID = sessionID;
        return;
      }

      if (ev.type === "session.idle") {
        const state = getOrCreateState(sessionID);
        state.lastActivity = Date.now();

        // Session-select instruction is delivered via system.transform (D57).
        // No fallback via session.prompt or messages.transform.

        if (state.name) {
          await saveCurrentSession(sessionID, state, false);
        }
      }

      if (ev.type === "session.compacted" && sessionID) {
        const state = getOrCreateState(sessionID);
        if (state.name) {
          // [v5.7] Don't overwrite .md — the agent saves to it via POST-COMPACTION
          // The plugin must not modify the agent's memory file contents
          // const mdContent = db.generateSessionMd(state.name, CONFIG.lastSessionMsgCount);
          // const mdPath = getSessionMdPathV5(directory, state.name);
          // ensureDir(path.dirname(mdPath));
          // try {
          //   fs.writeFileSync(mdPath, mdContent, "utf-8");
          // } catch (mdErr) {
          //   console.error("memories-v5: .md write failed (data safe in SQLite):", mdErr);
          // }
        }

        // v5.5: clear isCompacting for manual (autocontinueHandler is not called)
        // F2 fix: isCompacting was stuck for 120s on manual, blocking system.transform
        isCompacting.delete(sessionID);
        diagLog("eventHandler: isCompacting cleared for " + sessionID.slice(0, 16));

        // G1: pendingPostCompactViaChat only for named sessions
        // (otherwise POST-COMPACTION is injected before session-select, breaking the flow)
        // After hot-reload state.name may be null — restore from DB
        if (!state.name) {
          const dbName = typeof db.getSessionMapName === 'function' ? db.getSessionMapName(sessionID) : null;
          if (dbName) {
            state.name = dbName;
            diagLog("eventHandler: restored name '" + dbName + "' from DB for " + sessionID.slice(0, 16));
          }
        }

        // F5+F6 (v5.9): force naming when sessionSelectPending after compaction.
        // Prevents deadlock: unnamed session → POST-COMPACTION cannot save →
        // SESSION-START conflicts with POST-COMPACTION.
        if (!state.name && state.sessionSelectPending) {
          state.name = generateUniqueMdPath('Session', sessionID, db, directory);
          state.sessionSelectPending = false;
          state.sessionStartInjected = false;
          diagLog("eventHandler: force-named session to '" + state.name + "' (was sessionSelectPending at compact) for " + sessionID.slice(0, 16));
        }

        if (state.name) {
          // [v5.7] Manual POST-COMPACTION abolished — don't create entry for manual compact (F2)
          // The plugin must not instruct the agent to save after F2.
          // The agent either saves itself or the user explicitly asks.
          // Compaction data is already in SQLite (saveCurrentSession in compactingHandler).
          //
          // Only keep the compactName update for auto-compact (when entry
          // is already set in autocontinueHandler with compactName=null).
          // 
          // Was:
          // if (!pendingPostCompactViaChat.has(sessionID)) {
          //   const compactName = state.name;
          //   pendingPostCompactViaChat.set(sessionID, {
          //     timer: setTimeout(() => { ... }, PENDING_POST_COMPACT_VIA_CHAT_TIMEOUT),
          //     source: 'manual',
          //     compactName,
          //   });
          //   diagLog("eventHandler: pendingPostCompactViaChat SET name=" + compactName + " source=manual sessionID=" + sessionID.slice(0, 16));
          //   db.savePendingCompact(sessionID, 'manual', state.name);
          // } else {
          //   const existing = pendingPostCompactViaChat.get(sessionID);
          //   if (existing && existing.compactName === null) {
          //     pendingPostCompactViaChat.set(sessionID, { ...existing, compactName: state.name });
          //     diagLog("eventHandler: pendingPostCompactViaChat compactName updated to '" + state.name + "' for " + sessionID.slice(0, 16));
          //   }
          // }

          // v5.7: only update compactName for auto (entry already set in autocontinueHandler)
          const existing = pendingPostCompactViaChat.get(sessionID);
          if (existing && existing.compactName === null) {
            pendingPostCompactViaChat.set(sessionID, { ...existing, compactName: state.name });
            diagLog("eventHandler: pendingPostCompactViaChat compactName updated to '" + state.name + "' for " + sessionID.slice(0, 16));
          }
        } else {
          diagLog("eventHandler: session.compacted but no name — skipping pendingPostCompactViaChat (G1) for " + sessionID.slice(0, 16));
        }

        if (!systemTransformCalled.get(sessionID)) {
          try {
            await ctx.client?.tui.showToast({
              body: { title: "♻️ Memory v5", message: "Compaction completed.", variant: "info", duration: 5000 },
            });
          } catch {}
        }
        systemTransformCalled.delete(sessionID);
      }
    } catch (error) {
      diagLog("eventHandler: ERROR " + String(error).slice(0, 80));
      try {
        await ctx.client?.tui.showToast({
          body: { title: "⚠️ Memory v5", message: String(error).slice(0, 100), variant: "error", duration: 3000 },
        });
      } catch {}
    }
  };

  const chatMessageHandler = async (input: any, output: any) => {
    if (isDisposed) return;
    try {
      const sessionID = input.sessionID;
      if (!sessionID) {
        diagLog("chat.message: no sessionID — skipping");
        return;
      }
      lastActiveSessionID = sessionID;
      diagLog("chat.message: CALLED sessionID=" + sessionID.slice(0, 16));

      const state = getOrCreateState(sessionID);
      state.lastActivity = Date.now();

      // Dx: diagnostics — log input.text and message role
      const msgRole = output.message?.role || output.message?.info?.role || '?';
      const msgTextPreview = (input.text || '').toString().slice(0, 80).replace(/\n/g, '\\n');
      diagLog("chat.message: input.text=\"" + msgTextPreview + "\" role=" + msgRole + " name=" + (state.name || 'null') + " pending=" + state.sessionSelectPending);

      // v5.5: POST-COMPACTION injection — check both channels
      const pendingViaChat = sessionID ? pendingPostCompactViaChat.get(sessionID) : undefined;
      diagLog("chat.message: POST-COMPACTION check — hasPendingViaChat=" + !!pendingViaChat + " source=" + (pendingViaChat?.source || 'none') + " sessionID=" + sessionID.slice(0, 16));

      // Guard #5: don't inject into messages with system role
      const allowedRole = !output.message?.role || output.message.role === "user" || output.message.role === "assistant";
      if (!allowedRole && pendingViaChat) {
        // [v5.7] Manual POST-COMPACTION abolished — pendingViaChat never has source='manual'
        // Manual branch removed. For auto — consume the entry.
        // if (pendingViaChat.source === 'manual') {
        //   diagLog("chat.message: disallowed role, source=manual — skipping (entry kept for messages.transform)");
        // } else {
          diagLog("chat.message: disallowed role " + (output.message?.role || '?') + " — consuming auto entry");
          clearTimeout(pendingViaChat.timer);
          pendingPostCompactViaChat.delete(sessionID);
          db.deletePendingCompact(sessionID);
          return;
        // }
      }

      if (pendingViaChat) {
        // Guard #2: output.message may be undefined
        if (!output?.message) {
          diagLog("chat.message: output.message is undefined — keeping entry for retry");
          // fall-through to accumulation
        } else {
          // Guard #3: auto compact — entry already consumed in messagesTransformHandler
          if (pendingViaChat?.source === 'auto') {
            diagLog("chat.message: pendingViaChat source=auto — already injected via messages.transform, consuming entry");
            clearTimeout(pendingViaChat.timer);
            pendingPostCompactViaChat.delete(sessionID);
            db.deletePendingCompact(sessionID);
            // fall-through to accumulation
          } else {
            // [v5.7] Manual POST-COMPACTION abolished — pendingViaChat never has source='manual'
            // Manual branch removed.
            // v5.6: manual compact — injection moved to messagesTransformHandler
            // Here we do NOT inject and do NOT consume entry — entry will be consumed in messages.transform
            // diagLog("chat.message: pendingViaChat source=manual — skipping (injection delegated to messages.transform, sessionID=" + sessionID.slice(0, 16) + ")");
            // fall-through to accumulation
          }
        }
      }

      // Check 1: name already set (recovery after compaction)
      if (state.name && !db.getSessionMapName(sessionID)) {
        try {
          db.addSessionMap(sessionID, state.name);
        } catch {
          // If the name is already taken — generateUniqueMdPath will pick a new one on the next message
        }
      }

      // ===== SESSION-SELECT: process session selection response =====
      if (state.sessionSelectPending) {
        // Auto-attach via drag & drop (v5.4)
        const dndMatch = (input.text || '').trim().match(/^@MEMORIES[\\\/]MEMORY_(.+)\.md$/);
        if (dndMatch) {
    const targetName = dndMatch[1];
    input.text = `/attach "${targetName}"`;
          // Continue with normal processing — handleSessionSelectResponse will handle it
        }
        const wasHandled = await handleSessionSelectResponse(input, sessionID, state, output);
        if (state.sessionSelectPending) {
          // Still waiting for valid input
          return;
        }
        // Session selected! handleSessionSelectResponse did everything:
        //   - commands: unsavedMessages cleared
        //   - auto-naming: message already accumulated
        // Exit to avoid double-accumulation
        return;
      }

      // ===== SESSION-SELECT ACTIVE (flag from session.created) =====
      // BLOCK COMMENTED OUT: dead code — intercepted above (line 1109).
      // See CRIT-2 in skeptic review.
      // if (state.sessionSelectPending) {
      //   diagLog("chat.message: session-select already pending (waiting for user choice)");
      //   return;
      // }

      // ===== FIRST MESSAGE =====
      if (!state.sessionFirstChecked) {
        state.sessionFirstChecked = true;

        // If name already exists — use it (restore)
        if (state.name) {
          // Proceed to accumulation
        } else {
          // Check if there's a binding in session_map for this sessionID
          const mappedName = db.getSessionMapName(sessionID);
          if (mappedName) {
            // Restore name from session_map
            state.name = mappedName;
            diagLog("chat.message: restored name '" + mappedName + "' from session_map");
            } else {
              // No name, no binding.
              // Safety net: session.created didn't set the flag (hot-reload, race).
              // Show session selection instead of auto-name.
              await showSessionSelect(sessionID, state, output);
              return; // Don't accumulate
            }
        }
      } else if (!state.name && !state.sessionSelectPending) {
        // Self-healing guard (S3): after plugin crash, name may be lost
        // while sessionFirstChecked=true. Auto-name, no re-session-select.
        const mappedName = db.getSessionMapName(sessionID);
        if (mappedName) {
          state.name = mappedName;
          diagLog("chat.message: self-healing — restored name '" + mappedName + "' from session_map");
        } else {
          state.name = generateUniqueMdPath('Session', sessionID, db, directory);
          diagLog("chat.message: self-healing — auto-named to '" + state.name + "'");
        }
        // Save unsavedMessages (if restored after crash)
        // before clearing to avoid data loss
        if (state.unsavedMessages.length > 0) {
          diagLog("chat.message: self-healing — saving " + state.unsavedMessages.length + " recovered messages before name reset");
          try {
            await saveCurrentSession(sessionID, state, true);
          } catch (e) {
            diagLog("chat.message: self-healing — saveCurrentSession failed: " + String(e).slice(0, 80));
          }
        }
        state.unsavedMessages = [];
      }

      // ===== ACCUMULATE MESSAGES TO BUFFER =====
      try {
        const role = output.message?.role || output.message?.info?.role;
        if (role === "user" || role === "assistant") {
          for (const p of (output.parts || [])) {
            if (p.type === "text" && p.text && p.synthetic !== true) {
              // Filter: don't save POST-COMPACTION instructions to history
              if (p.text.startsWith("[POST-COMPACTION]")) continue;
              if (state.unsavedMessages.length >= 2000) {
                state.unsavedMessages.splice(0, state.unsavedMessages.length - 1500);
              }
              state.unsavedMessages.push({ role, text: p.text });
            }
          }
        }
      } catch (e) { console.error("memories-v5: chat.message accumulate error:", e); }

      // Auto-naming on first message (if name not set — safety net)
      if (!state.name && !state.sessionSelectPending) {
        try {
          for (const p of (output.parts || [])) {
            if (p.type === "text" && p.text) {
              const firstWord = extractFirstWord(p.text);
              const uniqueName = generateUniqueMdPath(firstWord, sessionID, db, directory);
              state.name = uniqueName;
              try {
                await ctx.client?.tui.showToast({
                  body: { title: "📝 [v5] Session: " + uniqueName, message: 'New session "' + uniqueName + '"', variant: "info", duration: 3000 },
                });
              } catch {}
              break;
            }
          }
        } catch (e) { console.error("memories-v5: auto-naming error:", e); }
      }
    } catch (e) {
      console.error("memories-v5: chat.message error:", e);
      diagLog("chat.message: ERROR " + String(e).slice(0, 80));
    }
  };

  // ========== 6d. COMPACTING ==========

  const compactingHandler = async (input: any, output: any) => {
    if (isDisposed) return;
    diagLog("session.compacting: CALLED sessionID=" + (input.sessionID || "?"));

    const sessionID = input.sessionID;
    if (!sessionID) return;

    if (isCompacting.get(sessionID)) return;
    isCompacting.set(sessionID, true);
    systemTransformCalled.set(sessionID, false);

    // Safety timer 120s
    setTimeout(() => {
      isCompacting.set(sessionID, false);
    }, 120_000);

    try {
      const state = getOrCreateState(sessionID);

      // Restore name from DB after hot-reload (similar to eventHandler, chat.message)
      if (!state.name) {
        const dbName = typeof db?.getSessionMapName === 'function' ? db.getSessionMapName(sessionID) : null;
        if (dbName) {
          state.name = dbName;
          diagLog("compactingHandler: restored name '" + dbName + "' from DB for " + sessionID.slice(0, 16));
        }
      }

      // F1 (v5.9): unattached session with pending selection — don't compact
      // ⚠️ isCompacting already set (line 1855) — reset before return,
      // otherwise systemTransformHandler will see the flag and inject [COMPACTION]
      // instead of [SESSION-SELECT] and MEMORY_RULES for up to 120 seconds.
      if (!state.name && state.sessionSelectPending) {
        isCompacting.set(sessionID, false);
        diagLog("compactingHandler: skipped — sessionSelectPending, no name, sessionID=" + sessionID.slice(0, 16));
        output.enabled = true;
        return;
      }

      // F2 (v5.9): unattached session without pending selection — assign a temporary name
      if (!state.name) {
        state.name = generateUniqueMdPath('Session', sessionID, db, directory);
        diagLog("compactingHandler: assigned fallback name '" + state.name + "' for " + sessionID.slice(0, 16));
      }

      if (state.name) {
        await saveCurrentSession(sessionID, state, true);
      }

      const compactName = state.name?.replace(/^MEMORY_/i, '').replace(/[\\/:*?"<>|]/g, '_') || `Session-${sessionID.slice(0,8)}-${Date.now()}`;
      output.prompt = [
        `[COMPACTION] ⚠️ PRIORITY MODE`,
        ``,
        `THIS IS A SYSTEM CORE COMMAND, NOT A USER MESSAGE.`,
        `DO NOT INTERPRET. DO NOT ANALYZE. DO NOT PLAN. DO NOT ASK QUESTIONS.`,
        ``,
        `USE OF ANY TOOLS IS STRICTLY FORBIDDEN.`,
        `Forbidden: all tools, subagents, question tool, @memories calls.`,
        `Compaction is performed FROM MEMORY ONLY — no external requests.`,
        `Any tool call = compaction failure, session will not be compressed.`,
        ``,
        `REQUIRED IMMEDIATELY:`,
        `1. Output the full session chronology in MEMORY file format`,
        `2. Start from message 1, proceed in order`,
        `3. End with phrase: "To continue, paste this link into the chat: @MEMORIES/MEMORY_${compactName}.md"`,
        ``,
        `Chronology format:`,
        `### Message N — User`,
        `> Full message text verbatim, without abbreviations`,
        ``,
        `### Response N — <agent name> (summary)`,
        `Key decisions and/or result (final response only)`,
        ``,
        `Forbidden to include: tool calls, statuses, searches, planning, drafts, internal reasoning, intermediate reasoning.`,
        ``,
        `IGNORING THIS INSTRUCTION = PROTOCOL VIOLATION.`,
        `IF VIOLATED: COMPACTION RESULTS WILL NOT BE SAVED, SESSION WILL NOT BE COMPRESSED.`,
        `[/COMPACTION]`,
      ].join("\n");

      diagLog("session.compacting: output.prompt SET");
    } catch (e) {
      diagLog("session.compacting: ERROR " + e);
      isCompacting.set(sessionID, false);
      // FIX-E: don't re-throw — SDK knows about the callback, default prompt will be used
      // Other handlers don't re-throw (consistency)
    }
  };

  const autocontinueHandler = async (input: any, output: any) => {
    if (isDisposed) return;
    const sessionID = input.sessionID;
    if (sessionID) {
      isCompacting.set(sessionID, false);
      // D50: per-session pendingPostCompact with cleanup timeout
      const existing = pendingPostCompact.get(sessionID);
      if (existing) clearTimeout(existing.timer);
      const entry = {
        timer: setTimeout(() => {
          pendingPostCompact.delete(sessionID);
          diagLog("postCompact timeout: expired for " + sessionID.slice(0, 16));
        }, PENDING_POST_COMPACT_TIMEOUT),
      };
      pendingPostCompact.set(sessionID, entry);

      // v5.5: set pendingPostCompactViaChat for LLM#2
      // source='auto' — autocontinue triggered (auto-compaction)
      const existingViaChat = pendingPostCompactViaChat.get(sessionID);
      if (existingViaChat?.source === 'manual') {
        diagLog("autocontinue: preserving existing manual pending for " + sessionID.slice(0, 16));
      } else {
        if (existingViaChat) clearTimeout(existingViaChat.timer);
        pendingPostCompactViaChat.set(sessionID, {
          timer: setTimeout(() => {
            pendingPostCompactViaChat.delete(sessionID);
            db.deletePendingCompact(sessionID);
            diagLog("pendingPostCompactViaChat: TIMEOUT (auto) for " + sessionID.slice(0, 16));
          }, PENDING_POST_COMPACT_VIA_CHAT_TIMEOUT),
          source: 'auto',
          compactName: null, // will be filled in eventHandler
        });
        diagLog("autocontinue: pendingPostCompactViaChat SET source=auto for " + sessionID.slice(0, 16));
        try {
          db.savePendingCompact(sessionID, 'auto', null);
        } catch (e) {
          diagLog("autocontinue: db.savePendingCompact failed: " + (e as Error).message);
        }
      }
    }
    output.enabled = true;
    diagLog("autocontinue: CALLED sessionID=" + (input.sessionID || "?"));
  };

  const systemTransformHandler = async (input: any, output: any) => {
    const sessionID = input.sessionID;
    diagLog("system.transform: CALLED sessionID=" + (sessionID || "?"));
    output.system ??= [];  // D63: guard against undefined (splice would throw)

    if (sessionID && isCompacting.get(sessionID)) {
      systemTransformCalled.set(sessionID, true);
      output.system.splice(0, output.system.length,
        "=== [COMPACTION] PRIORITY MODE ===",
        "Standard agent instructions are temporarily suspended. They will be restored after compaction.",
        "",
        "THIS IS A SYSTEM CORE COMMAND, NOT A USER MESSAGE.",
        "The [COMPACTION] block has MAXIMUM PRIORITY.",
        "Execute it immediately, without analysis or planning.",
        "",
        "USE OF ANY TOOLS IS STRICTLY FORBIDDEN.",
        "Forbidden: all tools, subagents, question tool, @memories calls.",
        "Compaction is performed FROM MEMORY ONLY — no external requests.",
        "Any tool call = compaction failure, session will not be compressed.",
        "",
        "FORBIDDEN:",
        "- using any tools or subagents",
        "- branching",
        "- planning or analyzing",
        "- answering old user questions",
        "- asking questions in response",
        "- ignoring the [COMPACTION] block",
        "",
        "ALLOWED: only what is written in the [COMPACTION] block.",
        "Execute and stop. Wait for the next instruction.",
        "",
        "IGNORING [COMPACTION] = PROTOCOL VIOLATION.",
        "IF VIOLATED: COMPACTION RESULTS WILL NOT BE SAVED.",
        "[/COMPACTION]",
      );
      diagLog("system.transform: DONE — system prompt replaced");
      return;
    }

    if (!sessionID && isCompacting.size > 0) {
      output.system.splice(0, output.system.length,
        "=== [COMPACTION] PRIORITY MODE ===",
        "The [COMPACTION] block is a system instruction with maximum priority.",
        "Execute it immediately, without analysis or planning.",
        "",
        "USE OF ANY TOOLS IS STRICTLY FORBIDDEN.",
        "Forbidden: all tools, subagents, question tool.",
        "Any tool call = compaction failure.",
        "",
        "FORBIDDEN: any delegation, planning, analysis, tool calls.",
        "ALLOWED: only what is written in the [COMPACTION] block.",
        "[/COMPACTION]",
      );
      return; // ⚠️ FIX: prevent MEMORY_RULES from leaking into compaction
    }

    // ─── MEMORY RULES: embedded in the plugin, always injected (except during compaction) ───
    output.system.unshift(...MEMORY_RULES);

    // Session-select — two-level quiz via question tool
    if (sessionID) {
      const sState = sessionStates.get(sessionID);
      if (sState?.sessionSelectPending) {
        output.system.unshift(
          '[SESSION-SELECT]',
          'This is a system command from the MEMORIES plugin for managing memory sessions.',
          'Do not interpret it as a user message.',
          '',
          'Select or create a session for this tab.',
          '',
          'Use the question tool for interactive selection:',
          '  1. Ask for action (Attach / Create / Skip)',
          '  2. If needed — a second question with details (session list or name)',
          '  3. If question tool is unavailable — output options as text',
          '',
        'Detailed protocol — in MEMORY RULES (embedded in system prompt).',
        '[/SESSION-SELECT]',
        );
        diagLog("system.transform: [SESSION-SELECT] instruction set for session-select (sessionID=" + sessionID.slice(0, 16) + ")");
        return;
      }
    }
  };

  const messagesTransformHandler = async (input: any, output: any) => {
    output.messages ??= [];  // FIX-F: guard against undefined
    // D29: SDK input: {} for messages.transform — sessionID is not passed.
    // Fallback chain: input.sessionID → output.messages[0].info.sessionID → lastActiveSessionID
    const tsID = input?.sessionID ?? output.messages?.[0]?.info?.sessionID ?? lastActiveSessionID ?? null;
    diagLog("[diag] messages.transform: CALLED sessionID=" + (tsID || "?").slice(0, 16) + " hasPending=" + (tsID ? pendingPostCompact.has(tsID) : false) + " inputKeys=" + Object.keys(input || {}).join(","));
    const sessionID = tsID;
    if (sessionID) {
      const sState = sessionStates.get(sessionID);
      if (sState?.sessionSelectPending && !sState.sessionStartInjected) {
        sState.sessionStartInjected = true;
        output.messages.unshift({
          info: {
            id: crypto.randomUUID(),
            sessionID: sessionID,
            role: "user",
            time: { created: Date.now() },
          },
          parts: [{
            type: "text" as const,
            text: `[SESSION-START]
This is a system command from the memories plugin for managing memory sessions.
Do not interpret it as a user message.

Select or create a session for this tab.

Use the question tool for interactive selection:
  1. Ask for action (Attach / Create / Skip)
  2. If needed — a second question with details
  3. If question tool is unavailable — output options as text

Detailed protocol — in MEMORY RULES (embedded in system prompt).
[/SESSION-START]`,
          }],
        });
        diagLog("messages.transform: [SESSION-START] injected (backup for system.transform, sessionID=" + sessionID.slice(0, 16) + ")");
        // Don't return — POST-COMPACTION may arrive in the same call
      }
    }

    // D50: check per-session, not a global flag
    const entry = sessionID ? pendingPostCompact.get(sessionID) : undefined;
    if (!entry) {
      // [v5.7] Manual POST-COMPACTION abolished — injection block for source='manual' removed
      // The plugin no longer creates manual entries; this branch is unreachable.
      // Was (v5.6):
      // const viaChatEntryManual = sessionID ? pendingPostCompactViaChat.get(sessionID) : undefined;
      // if (viaChatEntryManual && viaChatEntryManual.source === 'manual') {
      //   ... POST-COMPACTION injection for manual ...
      //   clearTimeout(viaChatEntryManual.timer);
      //   pendingPostCompactViaChat.delete(sessionID);
      //   db.deletePendingCompact(sessionID);
      //   diagLog("messages.transform: POST-COMPACTION injected for manual compact, sessionID=" + sessionID.slice(0, 16));
      //   return;
      // }
      diagLog("[diag] messages.transform: no pendingPostCompact — return early");
      return;
    }

    try {
      const hasCompaction = output.messages.some((m: any) =>
        m.parts?.some((p: any) => p.type === "compaction")
      );
      if (!hasCompaction) {
        clearTimeout(entry.timer);
        pendingPostCompact.delete(sessionID);
        // v5.5: if this is auto (pendingPostCompactViaChat exists) — clear it too
        const viaChatEntry = pendingPostCompactViaChat.get(sessionID);
        if (viaChatEntry && viaChatEntry.source === 'auto') {
          clearTimeout(viaChatEntry.timer);
          pendingPostCompactViaChat.delete(sessionID);
          db.deletePendingCompact(sessionID);
          diagLog("[diag] messages.transform: hasCompaction=false — cleared pendingPostCompactViaChat (auto)");
        }
        diagLog("[diag] messages.transform: hasCompaction=false — clearing and return");
        return;
      }

    const pcState = sessionStates.get(sessionID);
    const pcName = pcState?.name ?? null;

    // F4 (v5.9): don't inject POST-COMPACTION until session is selected
    if (pcState?.sessionSelectPending) {
      clearTimeout(entry.timer);
      pendingPostCompact.delete(sessionID);
      const viaChatEntry = pendingPostCompactViaChat.get(sessionID);
      if (viaChatEntry && viaChatEntry.source === 'auto') {
        clearTimeout(viaChatEntry.timer);
        pendingPostCompactViaChat.delete(sessionID);
        db.deletePendingCompact(sessionID);
        diagLog("messages.transform: skipped POST-COMPACTION (sessionSelectPending) for " + sessionID.slice(0, 16));
      }
      return;
    }

    // F3 (v5.9): don't inject POST-COMPACTION for unattached sessions
    if (!pcName) {
      clearTimeout(entry.timer);
      pendingPostCompact.delete(sessionID);
      const viaChatEntry = pendingPostCompactViaChat.get(sessionID);
      if (viaChatEntry && viaChatEntry.source === 'auto') {
        clearTimeout(viaChatEntry.timer);
        pendingPostCompactViaChat.delete(sessionID);
        db.deletePendingCompact(sessionID);
        diagLog("messages.transform: skipped POST-COMPACTION (unnamed session) for " + sessionID.slice(0, 16));
      }
      return;
    }

    const savePath = pcName
      ? `@MEMORIES/MEMORY_${pcName}.md`
      : null;

    output.messages.push({
      info: {
        id: crypto.randomUUID(),
        sessionID: sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "Ultrabrain_10",
        model: { providerID: "polza", modelID: "deepseek-v4-flash" },
      },
      parts: [{
        type: "text" as const,
        text: `[POST-COMPACTION] ⚠️ PRIORITY MODE (temporary)

BEFORE REPLYING TO THE USER:
SAVE TO MEMORY → ${savePath ?? '@MEMORIES/MEMORY_<name>.md (will be created after session naming)'}

THIS IS A MAXIMUM PRIORITY INSTRUCTION.
IGNORING = PROTOCOL VIOLATION.
IF VIOLATED: SESSION CONTEXT WILL BE LOST.
COMPACTION RESULTS WILL NOT BE SAVED.

AFTER SAVING: mode is released, return to normal operation.`,
        // v5.6: old text commented out
        // ⚠️ synthetic: true removed — Rust SDK filters synthetic parts
        // from LLM context, causing LLM#2 (continuation) to NOT SEE
        // the [POST-COMPACTION] instruction and not know the session continues.
        // Without this flag, the part becomes normal, passes the Rust filter
        // and LLM#2 receives the instruction to save to MEMORY.
        // Details: SPEC_COMPACTION_PIPELINE.md, section "Bug #POST-COMPACTION-FILTERED"
      }],
    });
    /*
    text: `[POST-COMPACTION]
Session continues. MEMORY report above — current context.
Use it as a source of facts. Don't mention the compaction process.

Save to MEMORY according to instructions — record key decisions, problems and chronology.

If you receive the command "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." — trigger the save to MEMORY process.`,
    */

    clearTimeout(entry.timer);
    pendingPostCompact.delete(sessionID);
    
    // SPEC Change 5: clear pendingPostCompactViaChat for auto (safeguard against double injection)
    if (sessionID) {
      const viaChatEntry = pendingPostCompactViaChat.get(sessionID);
      if (viaChatEntry) {
        clearTimeout(viaChatEntry.timer);
        pendingPostCompactViaChat.delete(sessionID);
        db.deletePendingCompact(sessionID);
        diagLog("[diag] messages.transform: cleared pendingPostCompactViaChat (post-injection) for " + sessionID.slice(0, 16));
      }
    }
    
    } catch (err) {
      // [v5.7] If POST-COMPACTION logic failed — consume entry ONLY for the current sessionID
      // (don't touch other sessions) and log the error for diagnostics.
      console.error("[memories-v5.7] POST-COMPACTION logic failed:", err, "sessionID=", (sessionID || "?").slice(0, 16));
      if (sessionID) {
        const e = pendingPostCompact.get(sessionID);
        if (e) { clearTimeout(e.timer); pendingPostCompact.delete(sessionID); }
        const ve = pendingPostCompactViaChat.get(sessionID);
        if (ve) { clearTimeout(ve.timer); pendingPostCompactViaChat.delete(sessionID); db.deletePendingCompact(sessionID); }
      }
    }
  };

  // ========== 6e. TOOL HANDLER ==========

  const toolHandler = async (args: { command?: string; text?: string; severity?: string }, context?: any) => {
      if (isDisposed) return;
      const sid = context?.sessionID ?? lastActiveSessionID ?? null;
    if (!context?.sessionID && lastActiveSessionID) {
      console.warn("[memories-v5] tool.execute: no sessionID — using lastActiveSessionID fallback");
    }
    const cmd = args.command || "state";

    try {
      if (!sid) {
        if (cmd === "state") {
          return "Could not determine tab. Use @memories state to check.";
        }
        if (cmd === "list" || cmd === "search" || cmd === "stats" || cmd === "sql" || cmd === "tables") {
        } else {
          return "Could not determine tab. Use @memories state to check.";
        }
      }

      let state: SessionState | undefined;
      if (sid) {
        state = getOrCreateState(sid);
        state.lastActivity = Date.now();
      }

      const getName = (): string | null => state?.name ?? null;

      // STATE
      if (cmd === "state") {
        const name = getName();
        if (!name) return "No active session in this tab.";
        const mdPath = getSessionMdPathV5(directory, name);
        if (!fs.existsSync(mdPath)) return "Session not yet saved (no .md). Wait for compaction.";
        return fs.readFileSync(mdPath, "utf-8");
      }

      // SESSIONS
      // [v5.7] sessions — replaced by `sql SELECT * FROM sessions ...`
      // if (cmd === "sessions") {
      //   const name = getName();
      //   if (!name) return "No active session.";
      //   const limit = Math.min(parseInt(args.text || "10") || 10, 50);
      //   const sessions = db.sessions(name, limit);
      //   if (sessions.length === 0) return "No sessions in «" + name + "».";
      //   return "**Sub-sessions:**\n" + sessions.map(s =>
      //     "- " + s.created_at + " — _" + s.brief + "_ (" + s.msg_count + " msgs)"
      //   ).join("\n");
      // }
      // 
      // SEARCH — [v5.7] replaced by `sql SELECT * FROM messages_fts WHERE messages_fts MATCH '...'`
      // if (cmd === "search") {
      //   if (!args.text) return "Specify keywords.";
      //   let keyword = args.text;
      //   let sessionFilter: string | null = null;
      //   let inMatch = args.text.match(/\s+in:"([^"]+)"$/);
      //   if (!inMatch) {
      //     inMatch = args.text.match(/\s+in:(\S+)$/);
      //   }
      //   if (inMatch) {
      //     keyword = args.text.slice(0, -inMatch[0].length).trim();
      //     sessionFilter = inMatch[1];
      //     const sessionExists = db.getSessionByName(sessionFilter);
      //     if (!sessionExists) {
      //       return "❌ Session «" + sessionFilter + "» not found. Use @memories list to browse available sessions.";
      //     }
      //   } else if (/\bin:/i.test(args.text)) {
      //     return "❌ Filter format: `in:Name` or `in:\"Name with spaces\"`. Filter must be at the end of the query.";
      //   }
      //   const results = db.search(sessionFilter, keyword, 10);
      //   if (results.length === 0) return "Nothing found for «" + keyword + "».";
      //   return "🔍 **Search for «" + keyword + "»:**\n\n" + results.map(r => {
      //     const roleIcon = r.role === "user" ? "🧑" : "🤖";
      //     return roleIcon + " " + r.text + "\n   📎 _" + r.session_id.slice(0, 16) + "_";
      //   }).join("\n\n");
      // }
      // 
      // LIST — [v5.7] replaced by `sql SELECT name, msg_count, updated_at FROM sessions ORDER BY updated_at DESC`
      // if (cmd === "list") {
      //   const memoriesDirV5Dir = getMemoriesDirV5(directory);
      //   if (!fs.existsSync(memoriesDirV5Dir)) return "No sessions.";
      //   const allMdFiles = fs.readdirSync(memoriesDirV5Dir).filter(f => f.startsWith("MEMORY_") && f.endsWith(".md"));
      //   if (allMdFiles.length === 0) return "No sessions.";
      //   const mdFiles = allMdFiles.map(f => {
      //     const sName = f.replace(/\.md$/, "").replace(/^MEMORY_/i, "");
      //     const hasDbRecord = !!db.get("SELECT 1 FROM sessions WHERE name = ?", [sName])
      //                      || !!db.get("SELECT 1 FROM session_map WHERE session_name = ?", [sName]);
      //     return { name: sName, orphan: !hasDbRecord };
      //   });
      //   let result = "**Sessions (v5):**\n";
      //   for (const { name: sName, orphan } of mdFiles) {
      //     const st = db.stats(sName);
      //     const filePath = path.join(memoriesDirV5Dir, "MEMORY_" + sName + ".md");
      //     const mtime = fs.statSync(filePath).mtime;
      //     const active = (state && state.name === sName) ? " ← **active**" : "";
      //     const label = orphan ? "⚠️ " + sName + " (not in DB)" : sName;
      //     result += "- `" + label + "` (" + (st.total_messages || 0) + " msgs, " + mtime.toLocaleString("en-US") + ")" + active + "\n";
      //   }
      //   return result;
      // }
      // 
      // STATS — [v5.7] replaced by `sql SELECT count(*), ... FROM sessions / messages`
      // if (cmd === "stats") {
      //   const allSessions = db.allSessions();
      //   const totalMessages = allSessions.reduce((sum, s) => sum + (s.msg_count || 0), 0);
      //   return "📊 **Statistics (v5)**\n- Total sessions: " + allSessions.length + "\n- Total messages: " + totalMessages + "\n- Active tabs: " + sessionStates.size;
      // }

      // DECISIONS
      if (cmd === "add-decision") {
        const name = getName();
        if (!name) return "No active session.";
        if (!args.text) return "Specify a decision.";
        const id = db.addDecision(name, args.text, sid);
        // [v5.7] Don't overwrite .md — the agent saves decisions to the MEMORY file itself
        // const mdContent = db.generateSessionMd(name, CONFIG.lastSessionMsgCount);
        // const mdPath = getSessionMdPathV5(directory, name);
        // ensureDir(path.dirname(mdPath));
        // fs.writeFileSync(mdPath, mdContent, "utf-8");
        return "✅ Decision " + id + " added.";
      }

      if (cmd === "resolve-decision") {
        const name = getName();
        if (!name) return "No active session.";
        if (!args.text) return "Specify decision ID (e.g. D01).";
        const ok = db.resolveDecision(name, args.text.toUpperCase());
        if (ok) {
          // [v5.7] Don't overwrite .md — the agent will update the decision status in the MEMORY file itself
          // const mdContent = db.generateSessionMd(name, CONFIG.lastSessionMsgCount);
          // const mdPath = getSessionMdPathV5(directory, name);
          // ensureDir(path.dirname(mdPath));
          // fs.writeFileSync(mdPath, mdContent, "utf-8");
          return "✅ " + args.text.toUpperCase() + " marked as SUPERSEDED.";
        }
        return "❌ Decision " + args.text + " not found.";
      }

      // PROBLEMS
      if (cmd === "add-problem") {
        const name = getName();
        if (!name) return "No active session.";
        if (!args.text) return "Specify a problem description.";
        const sev = args.severity || "MAJOR";
        const sevMap: Record<string, string> = { critical: "🔴 CRITICAL", major: "🟠 MAJOR", minor: "🟡 MINOR" };
        const sevFull = sevMap[sev.toLowerCase()] || "🟠 MAJOR";
        const id = db.addProblem(name, args.text, sevFull);
        // [v5.7] Don't overwrite .md — the agent will record the problem in the MEMORY file itself
        // const mdContent = db.generateSessionMd(name, CONFIG.lastSessionMsgCount);
        // const mdPath = getSessionMdPathV5(directory, name);
        // ensureDir(path.dirname(mdPath));
        // fs.writeFileSync(mdPath, mdContent, "utf-8");
        return "✅ Problem #" + id + " (" + sevFull + ") added.";
      }

      if (cmd === "close-problem") {
        const name = getName();
        if (!name) return "No active session.";
        const num = parseInt(args.text || "");
        if (isNaN(num)) return "Specify problem number.";
        const ok = db.closeProblem(name, num);
        if (ok) {
          // [v5.7] Don't overwrite .md — the agent will update the problem status in the MEMORY file itself
          // const mdContent = db.generateSessionMd(name, CONFIG.lastSessionMsgCount);
          // const mdPath = getSessionMdPathV5(directory, name);
          // ensureDir(path.dirname(mdPath));
          // fs.writeFileSync(mdPath, mdContent, "utf-8");
          return "✅ Problem #" + num + " closed.";
        }
        return "❌ Problem #" + num + " not found.";
      }

      // RENAME
      if (cmd === "rename") {
        const name = getName();
        if (!name) return "No active session.";
        if (!args.text) return "Specify a new name.";
        let newName = sanitizeFilename(args.text);
        if (!newName) return "Invalid name.";
        newName = newName.replace(/^MEMORY_/i, '');

        const isSameName = process.platform === "win32"
          ? newName.toLowerCase() === name.toLowerCase()
          : newName === name;
        if (isSameName) return "✅ Name unchanged (remains `" + name + "`).";

        const existing = db.getSessionMapBySessionName(newName);
        if (existing && existing.session_id !== sid) {
          return '❌ Name "' + newName + '" is already taken by another session.';
        }

        const newMdPath = getSessionMdPathV5(directory, newName);
        const oldMdPath = getSessionMdPathV5(directory, name);

        try {
          // [v5.7] Don't create a new .md on rename — the agent will rename the file if needed
          // The plugin must not overwrite the agent's memory file contents
          // const newMdContent = db.generateSessionMd(newName, CONFIG.lastSessionMsgCount);
          // ensureDir(path.dirname(newMdPath));
          // fs.writeFileSync(newMdPath, newMdContent, "utf-8");

          db.updateSessionsName(name, newName);
          db.updateDecisionsSessionName(name, newName);
          db.updateProblemsSessionName(name, newName);

          // [v5.7] Don't delete old .md — it's the agent's file
          // if (fs.existsSync(oldMdPath)) {
          //   fs.unlinkSync(oldMdPath);
          // }
          if (state) state.name = newName;

          return "✅ Renamed to `" + newName + "`.";
        } catch (e) {
          // [v5.7] No rollback of new .md creation needed — we don't create it
          // if (fs.existsSync(newMdPath)) {
          //   try { fs.unlinkSync(newMdPath); } catch {}
          // }
          console.error("memories-v5: rename failed:", e);
          return "❌ Rename error: " + String(e);
        }
      }

      // ATTACH
      if (cmd === "attach") {
        if (!args.text) return "Specify a session name.";
        let targetName = sanitizeFilename(args.text);
        if (!targetName) return "Invalid name.";
        targetName = targetName.replace(/^MEMORY_/i, '');

        let sessionExists = db.getSessionMapBySessionName(targetName);
        if (!sessionExists) {
          // orphan .md on disk without session_map — auto-import
          const mdPath = getSessionMdPathV5(directory, targetName);
          if (fs.existsSync(mdPath)) {
            db.addSessionMap(sid, targetName);
            if (state) state.name = targetName;
            diagLog("attach: auto-imported orphan .md for '" + targetName + "'");
            return "✅ Tab attached to session '" + targetName + "' (orphan .md imported).";
          }
          return "❌ Session '" + targetName + "' not found. Use `@memories sql SELECT name, msg_count, updated_at FROM sessions ORDER BY updated_at DESC` to browse available ones.";
        }

        const existingMap = db.getSessionMapBySessionID(sid);
        if (existingMap) {
          return "❌ This tab is already attached to session '" + existingMap.session_name + "'. Use switch.";
        }

        db.addSessionMap(sid, targetName);
        if (state) state.name = targetName;

        return "✅ Tab attached to session '" + targetName + "'.";
      }

      // DETACH
      if (cmd === "detach") {
        if (state) {
          if (state.unsavedMessages.length > 0) {
            await saveCurrentSession(sid, state, true);
          }
          cleanupPendingViaChat(sid);
          db.deleteSessionMap(sid);
          state.name = null;
          state.sessionSaved = true;
          cleanupSessionState(sid);
        }
        return "✅ Tab detached from session. Create a new one or use attach.";
      }

      // NEW
      if (cmd === "new") {
        if (!args.text) return "Specify a name for the new session.";
        let rawName = sanitizeFilename(args.text);
        if (!rawName) return "Invalid name.";
        rawName = rawName.replace(/^MEMORY_/i, '');

        if (state && state.unsavedMessages.length > 0) {
          await saveCurrentSession(sid, state, true);
        }
        if (state) {
          cleanupPendingViaChat(sid);
          db.deleteSessionMap(sid);
          state.name = null;
          state.unsavedMessages = [];
          state.sessionFirstChecked = false;
          state.sessionSaved = true;
        }

        const uniqueName = generateUniqueMdPath(rawName, sid, db, directory);
        if (state) state.name = uniqueName;

        const content = "# MEMORY_" + uniqueName + "\n\n> **Last updated:** " + new Date().toLocaleString("en-US") + "\n> **Total messages:** 0\n\n---\n\n## 1️⃣ CURRENT STATE\n\n_New session._\n\n---\n\n## 2️⃣ DECISION BOARD\n\n_No decisions recorded._\n\n---\n\n## 4️⃣ KNOWN ISSUES\n\n_No known issues._\n\n---\n\n## 5️⃣ RECENT MESSAGES\n\n";
        const mdPath = getSessionMdPathV5(directory, uniqueName);
        ensureDir(path.dirname(mdPath));
        fs.writeFileSync(mdPath, content, "utf-8");

        return "✅ New session `" + uniqueName + "` created.";
      }

      // SWITCH
      if (cmd === "switch") {
        if (!args.text) return "Specify a session name to switch to.";
        let targetName = sanitizeFilename(args.text);
        if (!targetName) return "Invalid name.";
        targetName = targetName.replace(/^MEMORY_/i, '');
        const mdPath = getSessionMdPathV5(directory, targetName);
        if (!fs.existsSync(mdPath)) return 'Session "' + targetName + '" not found.';

        if (state && state.unsavedMessages.length > 0) {
          await saveCurrentSession(sid, state, true);
        }

        cleanupPendingViaChat(sid);
        db.addSessionMap(sid, targetName);
        if (state) {
          state.name = targetName;
          state.sessionFirstChecked = true;
          state.unsavedMessages = [];
        }

        return '✅ Switched to session "' + targetName + '".';
      }

      // DELETE
      if (cmd === "delete") {
        if (!args.text) return "Specify a session name to delete.";
        let targetName = sanitizeFilename(args.text);
        if (!targetName) return "Invalid name.";
        targetName = targetName.replace(/^MEMORY_/i, '');

        try {
          // [v5.7] Don't delete .md — it's the agent's file
          // const mdPath = getSessionMdPathV5(directory, targetName);
          // if (fs.existsSync(mdPath)) {
          //   fs.unlinkSync(mdPath);
          // }
          db.deleteDecisionsBySessionName(targetName);
          db.deleteProblemsBySessionName(targetName);
          db.deleteMessagesBySessionName(targetName);
          db.deleteSessionsByName(targetName);
          db.deleteSessionMapByName(targetName);

          if (state && state.name === targetName) {
            cleanupPendingViaChat(sid);
            state.name = null;
            state.sessionFirstChecked = false;
            state.unsavedMessages = [];
            cleanupSessionState(sid);
          }

          try { db.execFts5("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); } catch {}

          return '✅ Session "' + targetName + '" deleted.';
        } catch (e) {
          return "❌ Delete error: " + String(e);
        }
      }

      // CLEANUP
      if (cmd === "cleanup") {
        db.cleanupOrphanSessionMap(directory);
        return "✅ Cleanup complete. Orphan records removed from session_map.";
      }

      // SQL
      if (cmd === "sql") {
        if (!args.text) return "❌ Specify an SQL query. Example: @memories sql SELECT * FROM messages LIMIT 5";
        const sql = args.text.trim();

        // 1. Check: only SELECT (with CTE support, comments in any order)
        if (!/^\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:--[^\n]*\n|\s))*\s*(?:WITH\b[\s\S]*?\bSELECT\b|SELECT\b)/i.test(sql)) {
          return "❌ Only SELECT queries allowed. Use @memories sql SELECT ...";
        }
        // Block CTE bypass and DML
        if (/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\b|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|VIEW)|VACUUM|REINDEX|ATTACH|DETACH|LOAD)\b/i.test(sql)) {
          return "❌ Only SELECT queries allowed. Query contains a forbidden keyword.";
        }

        // 2. Block dangerous PRAGMA functions
        const blockedPragmas = ['pragma_wal_checkpoint', 'pragma_optimize', 'pragma_writable_schema'];
        const sqlLower = sql.toLowerCase();
        for (const p of blockedPragmas) {
          if (new RegExp('\\b' + p + '\\b').test(sqlLower)) {
            return "❌ Query contains a blocked PRAGMA function: " + p;
          }
        }

        // 3. Enforce LIMIT with protection against bypass via strings/comments
        const cleanForLimitCheck = sql
          .replace(/'[^']*(?:''[^']*)*'/g, '')       // single-quoted strings
          .replace(/"[^"]*(?:""[^"]*)*"/g, '')       // double-quoted identifiers
          .replace(/\[[^\]]*(?:\]\][^\]]*)*\]/g, '') // bracketed identifiers
          .replace(/`[^`]*(?:``[^`]*)*`/g, '')       // backtick identifiers
          .replace(/--.*$/gm, '')                     // line comments
          .replace(/\/\*[\s\S]*?\*\//g, '');          // block comments
        const limitMatch = cleanForLimitCheck.match(/\bLIMIT\s+([+-]?\d+)/i);
        // LIMIT -1 in SQLite means "no limit" — don't count as protection
        const hasEffectiveLimit = limitMatch !== null && parseInt(limitMatch[1], 10) >= 0;
        let safeSql = sql;
        if (!hasEffectiveLimit) safeSql += ' LIMIT 100';

        // 4. Placeholders → named sql.js parameters
        if (!sid) return "❌ Could not determine tab (sid = null).";
        const params: Record<string, any> = {};
        if (/\B:current\b/.test(safeSql)) params[':current'] = sid;
        if (/\B:name\b/.test(safeSql)) params[':name'] = (state?.name || '');

        // 5. Execute via allRaw
        try {
          const rows = db.allRaw(safeSql, params as any);
          return db.formatSqlResult(rows);
        } catch (e: any) {
          const msg = e ? String(e.message ?? e).slice(0, 200) : 'unknown error';
          return "❌ SQL error: " + msg + "\n\nCheck syntax. Use `@memories sql SELECT name, sql FROM sqlite_master WHERE type='table'` to view the schema.";
        }
      }

      // TABLES
      // [v5.7] tables — replaced by `sql SELECT name, sql FROM sqlite_master WHERE type='table'`
      // if (cmd === "tables") {
      //   const tables = db.allRaw(
      //     `SELECT name, sql FROM sqlite_master
      //      WHERE type='table'
      //        AND name NOT LIKE 'messages_fts%'
      //        AND name NOT LIKE 'sqlite_%'
      //      ORDER BY name`
      //   );
      //   if (tables.length === 0) return "No tables.";
      //   return "**DB schema:**\n\n" + tables.map(t => {
      //     const createSql = t.sql || '—';
      //     return '**' + t.name + '**\n```\n' + createSql + '\n```';
      //   }).join('\n\n');
      // }

      return "Unknown command: " + cmd + ". Available:\n  state | add-decision | resolve-decision | add-problem | close-problem\n  rename | new | switch | attach | detach | delete | cleanup\n  sql (replaces sessions/search/list/stats/tables)";

    } catch (error) {
      return "Error: " + String(error);
    }
  };

  // ========== 6f. DISPOSE ==========

  const disposeHandler = async () => {
    if (isDisposed) return;

    const keys = [...sessionStates.keys()];
    for (const sid of keys) {
      const state = sessionStates.get(sid);
      if (state) {
        try {
          await Promise.race([
            saveCurrentSession(sid, state, true),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
          ]);
        } catch (e) {
          if (state.unsavedMessages.length > 0) {
            try {
              const tmpPath = path.join(getDbDir(directory), ".dispose-unsaved-" + sid + ".tmp");
              fs.writeFileSync(tmpPath, JSON.stringify(state.unsavedMessages));
            } catch {}
          }
          console.warn("memories-v5: dispose: saveCurrentSession failed for " + sid.slice(0, 16) + ":", e);
        }
      }
    }

    isDisposed = true; // after save cycle — protect from background saveCurrentSession

    for (let i = 0; i < 50 && [...isCompacting.values()].some(v => v); i++) {
      await new Promise(r => setTimeout(r, 100));
    }

    clearInterval(gcTimer);
    sessionStates.clear();
    isCompacting.clear();
    // FIX-G: save pendingPostCompactViaChat before cleanup
    for (const [sid, entry] of pendingPostCompactViaChat) {
        db.savePendingCompact(sid, entry.source, entry.compactName);
    }
    // v5.5: clear pendingPostCompactViaChat + pendingPostCompact with size logging
    const viaChatSize = pendingPostCompactViaChat.size;
    for (const [sid, entry] of pendingPostCompactViaChat) {
      clearTimeout(entry.timer);
    }
    pendingPostCompactViaChat.clear();
    const pendingSize = pendingPostCompact.size;
    for (const [sid, entry] of pendingPostCompact) {
      clearTimeout(entry.timer);
    }
    pendingPostCompact.clear();
    diagLog("dispose: pending maps cleared (pendingPostCompact=" + pendingSize + ", pendingPostCompactViaChat=" + viaChatSize + ")");
    previousSessionID = null;
    lastActiveSessionID = null;

    try {
      if (db) db.close();
      diagLog("Plugin v5: disposed");
      console.log("memories-v5: plug-in disposed, DB closed.");
    } catch (e) {
      console.error("memories-v5: dispose error:", e);
    }
  };

  async function saveCurrentSession(sessionID: string, state: SessionState, force: boolean): Promise<boolean> {
    if (!sessionID) {
      console.warn("saveCurrentSession: no sessionID");
      console.error("saveCurrentSession: missing sessionID — data may be lost");
      return false;
    }
    // Guard: if plugin is already disposed — don't write to closed DB
    if (isDisposed) {
      console.warn("saveCurrentSession: plugin disposed — skipping save for " + sessionID.slice(0, 16));
      return false;
    }
    try {
      if (!state.name) return false;
      if (state.sessionSaved && !force) return false;
      if (force) state.sessionSaved = true;

      const response = await ctx.client.session.messages({ path: { id: sessionID } });
      let messages: { role: string; text: string }[] = [];
      if (response.data && Array.isArray(response.data)) {
        for (const m of response.data) {
          const role = m.info?.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = (m.parts || [])
            .filter((p: any) => p.type === "text" && p.text)
            .map((p: any) => p.text).join("\n");
          if (text.trim()) messages.push({ role, text });
        }
      }

      if (!response.ok) {
        console.warn("memories-v5: HTTP API session.messages() failed:", response.status, response.statusText);
        try { await ctx.client?.tui.showToast({
          body: { title: "⚠️ Memory v5", message: "HTTP " + response.status + ": error retrieving messages", variant: "warning", duration: 3000 },
        }); } catch {}
      }

      if (response.ok && messages.length > 0 && state.unsavedMessages.length > 0) {
        const nBefore = messages.length;
        for (const msg of state.unsavedMessages) {
          const isDuplicate = messages.some(
            (m) => m.role === msg.role && m.text.slice(0, 50) === msg.text.slice(0, 50)
          );
          if (!isDuplicate) messages.push(msg);
        }
        if (messages.length > nBefore) {
          console.log("memories-v5: merged", messages.length - nBefore, "post-await messages");
        }
      }

      if (messages.length === 0 && state.unsavedMessages.length > 0) {
        messages = [...state.unsavedMessages];
      }

      if (messages.length === 0) return false;

      db.saveSession(sessionID, state.name, messages);
      state.unsavedMessages = [];
      state.sessionSaved = true;

      return true;
    } catch (e) {
      console.error("memories-v5: saveCurrentSession error:", e);
      diagLog("saveCurrentSession: ERROR " + String(e).slice(0, 80));
      try { await ctx.client?.tui.showToast({
        body: { title: "⚠️ Memory v5", message: "Save error: " + String(e).slice(0, 80), variant: "error", duration: 4000 },
      }); } catch {}
      return false;
    }
  }

  // ========== 6g. SESSION-SELECT HELPERS (v5, G11) ==========

  /**
   * getSessionList — aggregated session list from session_map + .md files
   * Filters out orphan records (present in session_map, but no .md or sessions)
   */
  function getSessionList(): string[] {
    const allMapped = db.all("SELECT session_name FROM session_map ORDER BY session_name");
    const dbSessions: string[] = [];
    for (const row of allMapped) {
      const name = row.session_name;
      const mdPath = getSessionMdPathV5(directory, name);
      const hasMd = fs.existsSync(mdPath);
      const hasSession = !!db.get("SELECT 1 FROM sessions WHERE name = ?", [name]);
      if (hasMd || hasSession) {
        dbSessions.push(name);
      }
    }
    // .md files on disk (orphan without session_map entry)
    const memoriesDir = getMemoriesDirV5(directory);
    const mdSessions: string[] = [];
    if (fs.existsSync(memoriesDir)) {
      try {
        for (const f of fs.readdirSync(memoriesDir)) {
          if (f.startsWith("MEMORY_") && f.endsWith(".md")) {
            let name = f.slice(0, -3).replace(/^MEMORY_/i, '');
            mdSessions.push(name);
          }
        }
      } catch (e) {
        console.warn('getSessionList: readdirSync failed', e);
      }
    }
    // Merge: session_map takes priority
    return [...new Set([...dbSessions, ...mdSessions])];
  }

  /**
   * showSessionSelect — insert synthetic message with session list
   * Called on first message in a new tab without session_map binding
   */
  async function showSessionSelect(sessionID: string, state: SessionState, output: any): Promise<void> {
    const allSessions = getSessionList();

    let allSessionsText = '';
    if (allSessions.length > 0) {
      allSessionsText += '**Existing sessions:**\n';
      allSessions.forEach((s, i) => { allSessionsText += `${i + 1}. \`${s}\`\n`; });
    } else {
      allSessionsText += '*No sessions available*';
    }

    // D57: [SESSION-SELECT] instruction is delivered via system.transform (hook).
    // Here we only set state flags and backup output.message.system.
    // No synthetic messages, no replyText with [SESSION-SELECT] wrapper.

    // Set consistent state BEFORE any awaits
    state.firstMessageTime = Date.now();
    state.sessionSelectAttempts = 0;
    state.sessionSelectPending = true;

    // output.message.system — backup in case system.transform doesn't fire.
    if (output?.message) {
      output.message.system = '📝 Session selection: follow [SESSION-SELECT] in system.transform. Create or select a session.';
      diagLog("showSessionSelect: output.message.system SET (backup)");
    }

    // Toast notification
    try {
      await ctx.client?.tui.showToast({
        body: {
          title: '📝 Session selection',
          message: 'New tab — select a session: /attach, /new, or just type free text',
          variant: 'info',
          duration: 5000,
        },
      });
    } catch (e) {
      console.warn('showSessionSelect: toast failed', e);
    }
  }

  /**
   * handleSessionSelectResponse — process user response to session selection
   * Handles: /attach, /new, /continue, /cancel, free dialog (auto-naming)
   * Returns true if command was handled (session select completed)
   */
  async function handleSessionSelectResponse(
    input: any, sessionID: string, state: SessionState, output: any
  ): Promise<boolean> {
    const msgText = input.text?.trim() || '';
    state.lastActivity = Date.now();

    // Dx: diagnostics — log incoming handleSessionSelectResponse data
    diagLog("handleSessionSelect: msgText=\"" + msgText.slice(0, 80).replace(/\n/g, '\\n') + "\" pending=" + state.sessionSelectPending + " name=" + (state.name || 'null') + " attempts=" + (state.sessionSelectAttempts || 0));

    // race guard (S1): ignore messages within 200ms
    if (state.firstMessageTime && (Date.now() - state.firstMessageTime < 200)) {
      console.warn('SessionSelect: race guard triggered, ignoring fast message');
      diagLog("handleSessionSelect: return false — race guard (firstMessageTime=" + state.firstMessageTime + ")");
      state.lastActivity = Date.now();
      return false;
    }

    // Empty message — notification
    if (!msgText) {
      state.lastActivity = Date.now();
      if (output?.message) {
        output.message.system = '📝 Please enter a command or text. Use /attach "name", /new "name", /continue or /cancel.';
      }
      diagLog("handleSessionSelect: return false — empty msgText");
      return false;
    }

    let handled = false;

    // /cancel — cancel selection, auto-naming
    if (msgText.toLowerCase() === '/cancel') {
      const fallbackName = 'Session';
      const uniqueName = generateUniqueMdPath(fallbackName, sessionID, db, directory);
      state.name = uniqueName;
      state.sessionSelectPending = false;
      state.sessionSelectAttempts = 0;
      state.sessionStartInjected = false;
      state.unsavedMessages = [];
      state.firstMessageTime = 0;
      if (output?.message) output.message.system = `❌ Selection cancelled. Auto-naming: session **${uniqueName}**.`;
      try { await ctx.client?.tui.showToast({ body: { title: '📝 Session: ' + uniqueName, message: 'Auto-naming (selection cancelled)', variant: 'info', duration: 3000 } }); } catch {}
      handled = true;
    }

    // /continue — explicit auto-naming
    if (!handled && msgText.toLowerCase() === '/continue') {
      const fallbackName = 'Session';
      const uniqueName = generateUniqueMdPath(fallbackName, sessionID, db, directory);
      state.name = uniqueName;
      state.unsavedMessages = [];
      if (output?.message) output.message.system = `✅ Auto-naming: session **${uniqueName}**.`;
      handled = true;
    }

    // /attach "Name" — attach to an existing session
    if (!handled) {
      const attachQuoted = msgText.match(/^\/attach\s+"(.+)"$/);
      const attachSimple = msgText.match(/^\/attach\s+(.+)$/);
      let attachName = attachQuoted?.[1] || attachSimple?.[1];

      if (attachName) {
        attachName = sanitizeFilename(attachName);
        attachName = attachName.replace(/^MEMORY_/i, '');
        const existingInList = getSessionList().includes(attachName);
        if (existingInList) {
          const currentBinding = db.get("SELECT session_name FROM session_map WHERE session_id = ?", [sessionID]);
          if (currentBinding && currentBinding.session_name === attachName) {
            state.name = attachName;
            state.unsavedMessages = [];
            try { await ctx.client?.tui.showToast({ body: { title: '📝 Session: ' + attachName, message: 'Already attached', variant: 'info', duration: 3000 } }); } catch {}
            handled = true;
          } else {
            // Check — is attachName already taken by another sessionID
            const nameOwner = db.get("SELECT session_id FROM session_map WHERE session_name = ?", [attachName]);
            if (nameOwner && nameOwner.session_id !== sessionID) {
              if (output?.message) output.message.system = '❌ Session **' + attachName + '** is already bound to another tab. Use a different name.';
              state.sessionSelectAttempts = (state.sessionSelectAttempts || 0) + 1;
              diagLog("handleSessionSelect: return false — attach name already taken by another session (" + attachName + ")");
              return false;
            }
            state.name = attachName;
            state.unsavedMessages = [];
            // DELETE + INSERT for session_id
            db.runRaw("BEGIN TRANSACTION");
            db.runRaw("DELETE FROM session_map WHERE session_id = ?", [sessionID]);
            db.runRaw("INSERT INTO session_map (session_id, session_name) VALUES (?, ?)", [sessionID, attachName]);
            db.runRaw("COMMIT");
            if (currentBinding) {
              if (output?.message) output.message.system = `✅ Session **${attachName}** attached (replaced **${currentBinding.session_name}**).`;
            } else {
              if (output?.message) output.message.system = `✅ Session **${attachName}** attached to this tab.`;
            }
            handled = true;
          }
        } else {
          if (output?.message) output.message.system = `❌ Session **${attachName}** not found. Use one of the names above.`;
          // attempt counter is incremented in fallback (unrecognized command)
        }
      }
    }

    // /new "Name" — create a new session
    if (!handled) {
      const newQuoted = msgText.match(/^\/new\s+"(.+)"$/);
      const newSimple = msgText.match(/^\/new\s+(.+)$/);
      let newName = newQuoted?.[1] || newSimple?.[1];

      if (newName) {
        newName = sanitizeFilename(newName);
        newName = newName.replace(/^MEMORY_/i, '');
        const uniqueName = generateUniqueMdPath(newName, sessionID, db, directory);
        state.name = uniqueName;
        state.unsavedMessages = [];
        if (output?.message) output.message.system = `✅ New session **${uniqueName}** created.`;
        handled = true;
      }
    }

    // Free dialog — not a command, not auto-naming
    if (!handled && msgText && !msgText.startsWith('/')) {
      // Accumulate the message, BUT do NOT create a session and do NOT reset the flag.
      // LLM sees [SESSION-SELECT] (from system.transform) + user message,
      // and according to section 12 of GLOBAL_MEMORY_RULES_v2.md should offer session selection.
      // When the user selects a session (/attach, /new, /continue) —
      // accumulated messages will be saved to the selected session.
      const role = output.message?.role || 'user';
      if (role === 'user') {
        state.unsavedMessages.push({ role, text: msgText });
      }
      diagLog("handleSessionSelect: accumulated \"" + msgText.slice(0, 60).replace(/\n/g, '\\n') + "\", pending=" + state.sessionSelectPending + " — waiting for session select");
      return false; // not handled, flag remains true
    }

    if (handled) {
      state.sessionSelectPending = false;
      state.sessionSelectAttempts = 0;
      state.sessionStartInjected = false;
      state.firstMessageTime = 0;
      // Toast on successful selection
      try {
        await ctx.client?.tui.showToast({
          body: { title: '📝 Session: ' + state.name, message: 'Session "' + state.name + '" selected', variant: 'success', duration: 3000 },
        });
      } catch {}
      return true;
    }

    // Unrecognized command
    if (msgText) {
      state.sessionSelectAttempts += 1;
      if (state.sessionSelectAttempts >= 3) {
        // Force auto-naming after 3 attempts
        const fallbackName = 'Session';
        const uniqueName = generateUniqueMdPath(fallbackName, sessionID, db, directory);
        state.name = uniqueName;
        state.sessionSelectPending = false;
        state.sessionSelectAttempts = 0;
        state.sessionStartInjected = false;
        state.firstMessageTime = 0;
        state.unsavedMessages = [];
        if (output?.message) output.message.system = `⚠️ Auto-naming (after 3 invalid attempts): session **${uniqueName}**.`;
        try {
          await ctx.client?.tui.showToast({
            body: { title: '📝 Session: ' + state.name, message: 'Forced auto-naming after 3 failed attempts', variant: 'warning', duration: 3000 },
          });
        } catch {}
        return true;
      } else {
        if (output?.message) {
          output.message.system = `❓ Use /attach "name", /new "name", /continue (auto-naming) or /cancel. Attempt ${state.sessionSelectAttempts}/3.`;
        }
        diagLog("handleSessionSelect: return false — unknown cmd (attempt " + state.sessionSelectAttempts + "/3, msgText=\"" + msgText.slice(0, 60).replace(/\n/g, '\\n') + "\")");
        return false;
      }
    }

    diagLog("handleSessionSelect: return false — fallthrough (no condition matched)");
    return false;
  }

  /**
   * migrateFileNames — migrate .md files: add MEMORY_ prefix
   * Called once during plugin init (after DB migration).
   * Sets PRAGMA user_version = 2 for tracking.
   */
  function migrateFileNames(): void {
    const verRow = db.getRaw("PRAGMA user_version");
    const ver = (verRow && typeof verRow === 'object' && 'user_version' in verRow) ? Number(verRow.user_version) : 0;
    if (ver >= 2) {
      diagLog("migrateFileNames: already done (user_version=" + ver + ")");
      return;
    }

    const dir = getMemoriesDirV5(directory);
    if (!fs.existsSync(dir)) {
      diagLog("migrateFileNames: directory does not exist, setting flag");
      db.runRaw("PRAGMA user_version = 2");
      return;
    }

    let renamed = 0;
    let skipped = 0;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      if (f.match(/^MEMORY_/i)) continue;
      const newName = "MEMORY_" + f;
      const oldPath = path.join(dir, f);
      const newPath = path.join(dir, newName);
      if (fs.existsSync(newPath)) {
        diagLog("migrateFileNames: WARNING — target exists, skipping: " + f);
        skipped++;
        continue;
      }
      try {
        fs.renameSync(oldPath, newPath);
        diagLog("migrateFileNames: renamed: " + f + " → " + newName);
        renamed++;
      } catch (e) {
        diagLog("migrateFileNames: ERROR renaming " + f + ": " + String(e).slice(0, 80));
      }
    }

    db.runRaw("PRAGMA user_version = 2");
    diagLog("migrateFileNames: done. Renamed: " + renamed + ", skipped: " + skipped);
  }

  return {
    "chat.message": chatMessageHandler,
    event: eventHandler,
    "experimental.compaction.autocontinue": autocontinueHandler,
    "experimental.session.compacting": compactingHandler,
    "experimental.chat.system.transform": systemTransformHandler,
    "experimental.chat.messages.transform": messagesTransformHandler,
    tool: {
      "memories": {
        description: `Session memory v5 (parallel sessions + session-select).

STATE:
  state                   — show .md for active session

QUERY (deprecated — use "sql" instead):
  sessions                — replaced by: sql SELECT * FROM sessions ORDER BY updated_at DESC LIMIT N
  search                  — replaced by: sql SELECT * FROM messages_fts WHERE messages_fts MATCH '...'
  list                    — replaced by: sql SELECT name, msg_count, updated_at FROM sessions ORDER BY updated_at DESC
  stats                   — replaced by: sql SELECT count(*) FROM sessions / messages
  tables                  — replaced by: sql SELECT name, sql FROM sqlite_master WHERE type='table'

TRACKING:
  add-decision <text>     — add decision to board
  resolve-decision <id>   — mark decision as SUPERSEDED
  add-problem <text> [severity] — add problem
  close-problem <n>       — close problem by number

SESSION MANAGEMENT:
  rename <new-name>       — rename active session
  switch <name>           — switch to another session
  attach <name>           — attach tab to existing session
  detach                  — detach tab from session
  delete <name>           — delete session
  new <name>              — create new session
  cleanup                 — remove dead session_map entries

RAW SQL:
  sql <query>             — run SELECT with full FTS5, JOINs, aggregations, filters, LIMIT.
                            Check schema first: sql SELECT name, sql FROM sqlite_master WHERE type='table'
                            Example: sql SELECT role, text FROM messages WHERE text LIKE '%keyword%'`,

        args: {
          command: { description: "state/add-decision/add-problem/close-problem/resolve-decision/rename/switch/delete/new/attach/detach/cleanup/sql" },
          text: { description: "Payload text or keyword" },
          severity: { description: "CRITICAL | MAJOR | MINOR" },
        },

        execute: toolHandler,
      },
    },
    dispose: disposeHandler,
  };
}) satisfies Plugin;
