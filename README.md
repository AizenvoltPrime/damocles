<div align="center">
  <img src="https://raw.githubusercontent.com/AizenvoltPrime/damocles/main/resources/icon.png" alt="Damocles" width="128">
  <h1>Damocles</h1>
  <p>A powerful AI coding assistant, just keep in mind that just because something works doesn't mean it's good.</p>
</div>

## Screenshots

<div align="center">
  <img src="docs/images/chat-interface.png" alt="Chat interface with inline diff previews" width="800">
  <p><em>Chat interface with Edit tool cards showing syntax-highlighted inline diffs</em></p>
</div>

<div align="center">
  <img src="docs/images/plan-view.png" alt="Plan mode with implementation plan" width="800">
  <p><em>Plan View displaying implementation plans for review</em></p>
</div>

<div align="center">
  <img src="docs/images/subagent-view.png" alt="Subagent visualization with tool actions" width="800">
  <p><em>Subagent View showing nested agent actions with real-time tool visualization</em></p>
</div>

## Features

- **Chat Interface**: Integrated chat panel for conversing with Claude — available as a secondary sidebar view (right side) or an editor panel (`Ctrl+Shift+U`). Both modes support all features and can run simultaneously with independent sessions
- **Code Assistance**: Get help with coding, debugging, refactoring, and more
- **Syntax Highlighting**: Shiki-powered code blocks with VS Code-quality highlighting and one-click copy
- **Diff Approval**: Review and approve file changes with syntax-highlighted unified diffs (supports concurrent diffs)
- **Inline Diff Preview**: Edit/Write tool results show inline diff previews with click-to-expand full-panel view
- **Tool Visualization**: See what tools Claude is using in real-time with expandable details
- **Tool Overlays**: Click tool cards to view full output in a full-screen overlay — supports built-in tools (Bash, Read, Grep, Glob, WebFetch, WebSearch) with syntax highlighting or markdown rendering, and MCP tools with markdown output and image rendering (base64 image blocks displayed as thumbnails with click-to-enlarge lightbox). Read overlays show a file metadata card with line range, total lines, and a progress bar for partial reads
- **Subagent Visualization**: Nested view of Task tool calls showing agent type, model, tool calls, and results
- **Streaming Responses**: Watch Claude's responses as they're generated
- **@ Mentions**: Type `@` to reference workspace files or agents (`@agent-Explore`, etc.) with fuzzy search autocomplete
- **Custom Agents**: Define custom agents in `.claude/agents/*.md` (project) or `~/.claude/agents/*.md` (user)
- **Voice Input**: Click the microphone button in the chat input to dictate messages via speech-to-text. Supports OpenAI Whisper, Deepgram, and Google Cloud STT providers. Audio is recorded extension-side using native platform APIs (Windows/macOS/Linux) and transcribed via your configured provider. Configure provider, API key, and language in the settings panel. **Note:** Requires local audio hardware — not available when connected to a remote host via SSH (the extension host runs server-side where no microphone is present)
- **Image Attachments**: Paste images from clipboard directly into chat (supports PNG, JPEG, GIF, WebP up to 5MB)
- **IDE Context**: Automatically include the active file or selected code in your message (toggleable in input bar)
- **Slash Commands**: Type `/` for built-in commands (`/clear`, `/compact`, `/rewind`, etc.) and custom commands from `.claude/commands/`
- **Prompt History**: Navigate previous prompts with arrow keys (shell-style)
- **Session Management**: Create, rename, resume, delete, and search sessions with confirmation
- **Panel Persistence**: Panels and active sessions survive VS Code restarts
- **Multi-Panel Sync**: Prompt history syncs across all open panels instantly
- **Context Stats**: Live tracking of token usage, cache activity, context window %, and session cost. "View Details" button opens the Context Usage Overlay — a full-screen view with SVG ring chart, stacked category bar, per-category breakdown, and collapsible detail sections for MCP tools, memory files, skills, and custom agents. Also accessible via `/context`
- **Session Logs**: Quick access button to open the raw JSONL session file (also works for subagent logs)
- **Model Selection**: Switch between Opus 4.6, Opus 4.5, Sonnet 4.6, and Haiku 4.5 with per-panel model selection and a separate workspace-wide default for new panels
- **Adaptive Thinking**: Model-aware thinking configuration driven by SDK-reported capabilities — adaptive models use configurable reasoning effort (Low/Medium/High/Max), legacy models use the classic toggle + token budget (1K-64K). Settings panel auto-detects the active model and dynamically shows supported effort levels
- **Per-Panel Permission Mode**: Each panel can have its own permission mode independent of the global default
- **YOLO Mode**: Toggle to auto-approve all tool calls (except plan approval and questions). Ephemeral setting that resets on session clear.
- **Custom Permission Rules**: Define persistent allow/deny rules for tools in Claude Code CLI-compatible settings files. Rules support pattern matching (e.g., `Bash(git:*)`, `Edit(*.ts)`). Permission prompts include "Always allow" and "Always deny" options that save rules to your chosen settings file.
- **Subagent-Scoped Accept All**: When you click "Accept all edits" on a subagent's permission prompt, only that subagent is auto-approved—the global session mode stays unchanged. Each subagent can be independently auto-approved without affecting the main session or other subagents.
- **Plan Mode**: When enabled, Claude creates implementation plans for your approval before making changes. Review plans in a modal, approve with auto-accept or manual mode, or request revisions with feedback. Dismissing the overlay (Escape) hides it without canceling — click the tool card to reopen, or press Escape again to reject. View session plan anytime via the header button
- **Clear Context & Auto-Accept**: Plan approval option that clears conversation context and starts fresh with the plan injected (matches Claude Code CLI behavior). Preserves planning session as reference while implementation runs in a clean session. The overlay header shows a context usage badge with threshold-based colors so you can make an informed decision
- **Bind Plan to Session**: Inject a custom plan file into the session via the link icon in the header. Claude is notified of the plan file path so it can reference the plan.
- **File Checkpointing**: Track file changes and rewind to any previous state with the Rewind Browser (`/rewind`)
- **Task List**: Visual display of Claude's current tasks with status tracking, dependencies (`blockedBy`), and active form indicators
- **Message Queue**: Send messages while Claude is working - they're injected at the next tool boundary
- **Context Distillation (Beta)**: Alternative context strategy that replaces the SDK's built-in session resume with a per-session FTS5 database and a Haiku observer. Each panel independently chooses `default` or `distill` via "This panel" and "Default for new panels" dropdowns in the settings panel. The full lifecycle of a distill-mode turn:

  **1. Prompt submission** — The user message is persisted client-side to a JSONL file with a `parentUuid` chain (the SDK does not handle persistence in distill mode). Any pending Haiku observation from the previous turn is awaited via a wait-gate before proceeding. A fresh, stateless SDK query is created (`persistSession: false`) with a rotating `sessionId`, while a stable `persistenceSessionId` is used for the JSONL filename, database, and webview display.

  **2. Context injection** — The `UserPromptSubmit` hook fires before the query reaches the API. When query decomposition is enabled (`damocles.distillQueryDecomposition`, default `true`), Haiku first decomposes the user's prompt into 1-4 keyword-rich search facets — each targeting a different topic or intent. For example, "fix the permission handler and update the annotation pipeline" becomes two facets: `"permission handler fix"` and `"annotation pipeline update"`. Each facet runs as a separate BM25 query, results are deduplicated (keeping the best rank per entry), and merged — ensuring balanced topic coverage that a single flattened query would miss. When decomposition is disabled or times out, the retriever falls back to a single BM25 query from the raw prompt. The context retriever builds a two-layer result within a configurable token budget (`damocles.distillTokenBudget`, default 4000, range 500–16000, adjustable from the settings panel): _continuity_ (the previous prompt's summary — always included to maintain conversational flow) and _relevant context_ (BM25-matched entries from any earlier prompt, with related-file expansion, filled until the budget is exhausted). When semantic re-ranking is enabled (`damocles.distillReranking`), BM25 retrieval widens to 100 results, the top 40 candidates are sent to Haiku for relevance scoring (0–10 via structured JSON output), and entries are selected by Haiku's score instead of BM25 rank — with timeout fallback to BM25 order. Reranking is automatically skipped when the annotated entry count is below 25 (the empirical breakeven point), since BM25 alone produces near-optimal results at small index sizes. After selection, entries connected via cross-prompt links are expanded into the result (up to 10 linked entries). The result is injected as a `<distilled_session_context>` block in the SDK's `additionalContext` field, giving the stateless query awareness of the full session history without replaying it.

  **3. Stateless query execution** — The SDK query runs against the API with no prior conversation state. As Claude responds, an `EntryTracker` groups tool calls by file path (Read/Write/Edit/Glob/Grep), command (Bash), or web activity (WebSearch/WebFetch) into pending context entries. Each entry records the tool name and a one-line input summary. Assistant text and tool results are persisted to the session JSONL in real-time with `parentUuid` chaining. Subagent tool calls (from the Task tool) are routed to separate `agent-{id}.jsonl` files keyed by the parent `tool_use_id`, enabling full subagent overlay visualization for both live execution and history loading.

  **4. Haiku annotation** — When the main response completes (including on user cancel), the `EntryTracker` finalizes — committing all pending entries to the per-session SQLite database (`~/.damocles/context/distill/{sessionId}.db`). Entries transition from `pending` to `annotating`, and up to 10 entries that failed annotation on prior prompts are included for retry. A single Haiku query fires with `outputFormat: { type: 'json_schema' }` — no MCP tools, no multi-turn conversation. Haiku receives the current prompt's entries, retry entries from prior failures, and up to 30 historical annotated entries, and outputs a validated JSON object containing: per-entry annotations (description, tags, related files, confidence score, semantic group label, low-relevance flag), cross-prompt entry links (depends_on, extends, reverts, related), and a prompt summary. The SDK auto-retries on malformed JSON. Annotation is incremental — even partial structured output from retry errors is applied rather than discarding the entire batch. Successfully annotated entries transition to `annotated`; unannotated entries are marked `failed` for automatic retry on the next prompt. All annotations are applied in a single batch: entry descriptions/tags/confidence/semantic_group update in the database (triggering FTS5 index updates via SQL triggers), low-relevance flags are set, links are inserted into the `entry_links` table, semantic groups are upserted in the `semantic_groups` tracking table, and the prompt summary is upserted. Entry IDs are validated against the combined current + retry set — hallucinated IDs are rejected. The full annotation result is persisted to `prompt-{N}/haiku.jsonl` for debugging. The sparkles icon in the chat header opens the Haiku Observer overlay showing an annotation summary card per prompt (annotated count, low-relevance count, failed count, link count, semantic group badges, summary text), prompt navigation, and buttons to open the raw log or context summary.

  **5. Context injection viewer** — Each user message includes an always-visible pill (pulsing indicator + database icon). Clicking it opens the Context Injection Overlay — a full-screen view with tabbed UI (Distill | Memory) showing exactly what context was injected for that prompt. The Distill tab parses structured context into entry cards showing file paths, prompt indices, semantic groups, and descriptions. When decomposition is enabled, a "Decomposition" badge and facets tag list are displayed. When reranking is enabled, it renders a side-by-side comparison of BM25-ranked vs Haiku-reranked context. The Memory tab shows the catalog entries per tier with score breakdowns, pinned memories with full content, FTS query terms, and retrieval boost indicators. Distill context is persisted in the per-session distill database; memory injection metadata is persisted in per-session SQLite databases (`~/.damocles/context/memory/{sessionId}.db`) via a write-through cache, so the viewer works for both live and historical sessions.

  **6. Next prompt** — The cycle repeats. The FTS5 query builder tokenizes the new user prompt, removes stopwords, and constructs an OR query of up to 16 quoted terms. BM25 ranking surfaces entries whose descriptions, tags, semantic groups, and file paths best match the query — only entries with `annotation_status = 'annotated'` are searched (pending and failed entries are excluded). Cross-prompt links allow related entries from earlier prompts to be pulled in even when they don't match by keyword. Semantic group expansion pulls up to 3 additional entries from the same group as any BM25 hit (e.g., if a hit is tagged `"auth-refactor"`, other entries from that group are surfaced). Because context cost is bounded by the token budget (converted to characters at 4 chars/token), usage stays constant regardless of conversation length — a 50-turn session uses the same context window as a 5-turn session.

  <details>
  <summary><strong>Retrieval pipeline flow diagrams</strong></summary>

  FTS5/BM25 is the foundation of all retrieval paths. Decomposition and reranking are optional layers that compose orthogonally — each operates at a different pipeline stage.

  **Basic (decomposition OFF, reranking OFF):**

  ```
  User prompt
      │
      ▼
  buildFtsQuery(prompt)           ← tokenize, remove stopwords, build OR query
      │
      ▼
  FTS5 BM25 search                ← single query, limit 50
      │
      ▼
  Expand related files + semantic groups → token budget cap → output
  ```

  **Multi-pass (decomposition ON, reranking OFF):**

  ```
  User prompt
      │
      ▼
  decomposeQueryWithHaiku()       ← Haiku extracts 1-4 keyword-rich facets
      │                              e.g. ["auth handler fix", "login component error"]
      ▼
  runMultiPassRetrieval(facets)   ← separate FTS5 BM25 query per facet
      │
      ├── BM25("auth" OR "handler" OR "fix")
      ├── BM25("login" OR "component" OR "error")
      │
      ▼
  Deduplicate (keep best rank per entry) → sort → cap at limit
      │
      ▼
  Expand related files + semantic groups → token budget cap → output
  ```

  Each facet still calls `buildFtsQuery()` → FTS5 internally. Decomposition multiplies BM25 queries rather than bypassing them, giving targeted coverage across distinct topics that a single flattened query would dilute.

  **Re-ranked (decomposition OFF, reranking ON):**

  ```
  User prompt
      │
      ▼
  buildFtsQuery(prompt)           ← single FTS5 OR query
      │
      ▼
  FTS5 BM25 search                ← widened to limit 100
      │
      ▼
  Take top 40 candidates
      │
      ▼
  rerankWithHaiku()               ← Haiku scores each 0-10 relevance
      │
      ▼
  Re-sort by relevance score → expand linked entries + semantic groups → output
  ```

  **Full pipeline (decomposition ON, reranking ON):**

  ```
  User prompt
      │
      ▼
  decomposeQueryWithHaiku()       ← 1-4 facets
      │
      ▼
  runMultiPassRetrieval(facets)   ← multi-pass FTS5, limit 100
      │
      ▼
  Take top 40 candidates
      │
      ▼
  rerankWithHaiku()               ← Haiku scores 0-10
      │
      ▼
  Re-sort by relevance score → expand linked entries + semantic groups → output
  ```

  The facade orchestrates this as a pipeline: decompose (optional) → BM25 retrieval (always, uses facets if available) → reranking (optional) → pick `rerankedContent ?? bm25Content` as final output. Each stage falls back gracefully on timeout/error — decomposition falls back to single-pass BM25, reranking falls back to BM25 order.

  </details>

- **Auto-Compact**: Automatic context compaction via configurable thresholds (`damocles.autoCompact`). Visual warnings at `warningThreshold`/`softThreshold`, auto-triggers `/compact` at `hardThreshold` to prevent context overflow
- **Persistent Memory**: 5-tier memory system (session, project, global, notes, observations) stored in WASM-based SQLite. No native modules — works cross-platform without compilation. Memories survive compactions and sessions, giving Claude continuity across conversations. Uses a **pull-first catalog model**: each prompt receives a compact relevance-ranked catalog (~300-800 tokens) of available memories, and Claude retrieves full details on demand via `get_memory_details`. This matches how CLAUDE.md works — a reference Claude consults selectively — and eliminates token displacement from irrelevant auto-injection
- **Pinned Memories**: User-designated memories that are always injected in full content, bypassing the catalog. Pin/unpin via MCP tools (`pin_memory`/`unpin_memory`) or the overlay UI. Configurable budget (default 500 tokens)
- **Retrieval Tracking**: When Claude calls `get_memory_details`, retrievals are recorded and fed back into catalog ranking. Memories Claude actively uses rank higher in future catalogs — a closed feedback loop
- **Observation Staleness**: When source files referenced by an observation are modified, the observation is automatically marked stale. Claude sees `[stale]` tags in context and can verify whether the observation is still accurate, then mark it fresh via the `reset_observation_staleness` MCP tool
- **Memory Commands**: `/remember <text>` saves session memory (prefix `project:` or `global:` for broader scope), `/note <text>` saves to a searchable knowledge base, `/memories` opens the management panel
- **Observations**: Claude voluntarily records rich observations via MCP tool after significant work — structured entries with type, title, narrative, facts, tags, and file paths. Zero additional API cost
- **Memory MCP Tools**: 7 in-process tools for Claude: `save_observation`, `search_memories`, `get_memory_details`, `get_timeline`, `save_note`, `list_notes`, `reset_observation_staleness`. Progressive disclosure keeps token usage efficient
- **Smart Session Handoff**: New sessions automatically receive the previous session's summary and top-ranked observations from recent sessions, weighted by file proximity to the active editor
- **Memory Panel**: 5-tab full-screen overlay (Session, Project, Global, Notes, Observations) for browsing, creating, deleting, pinning/unpinning, and searching memories. Pinned memories show an amber left-border accent
- **Chrome Browser Integration**: Built-in MCP server for Chrome browser automation — take screenshots, execute JavaScript, click elements, navigate pages, and more. Disabled by default; enable from the MCP status panel toggle or via `damocles.chrome.enabled`. Requires the [Claude Code Chrome Extension](https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn?utm_source=item-share-cb) installed in Chrome. The server appears as a toggleable entry in the MCP status panel alongside external MCP servers
- **MCP Server Management**: Enable/disable MCP servers from the UI with settings persisted to Claude config. Status panel shows per-server tool counts with expandable details and annotation badges (read-only, destructive, network), error messages for failed servers, and reconnect/authenticate actions
- **Hooks Support**: Claude Code hooks (shell commands that run on events like tool calls) work automatically
- **Plugins Support**: Enable/disable Claude Code plugins from the UI - plugins can provide agents and slash commands
- **Skills Support**: Approve or deny skill invocations. Includes the SDK-bundled `/batch` skill for decomposing large changes into parallel background agents in isolated git worktrees
- **Provider Profiles**: Define and switch between API providers (Anthropic, Z.AI, OpenRouter, etc.) with per-panel profile selection
- **Remote Control (REPL Bridge)**: Toggle the SDK's WebSocket-based remote session control from the chat header. Enables external tools and scripts to connect to the running Claude session via REPL. The globe icon opens a popover with an on/off switch, connection status, and per-URL copy buttons for the session and connect endpoints. State persists across query recreations (model change, MCP restart)
- **Localization**: UI translated into multiple languages, automatically matches VS Code's display language

## Installation

1. Clone the repository
2. Run `npm install`
3. Run `npm run build`
4. Press F5 in VS Code to launch the Extension Development Host

## Usage

- Open the Damocles sidebar view in the secondary sidebar (right side), or click the Damocles icon in the editor title bar (top right) to open a panel
- Type your question or request in the chat input
- Press Enter to send (Shift+Enter for new line)
- Review any file changes in the diff view before approving

### Keyboard Shortcuts

- `Ctrl+Shift+U` / `Cmd+Shift+U`: Focus the chat panel
- `↑` / `↓`: Navigate through prompt history (like terminal shell)
- `Shift+Tab`: Cycle through permission modes
- `Escape`: Cancel current request (when processing)
- `Escape Escape`: Open rewind popup to restore previous state

### IDE Context

The input bar shows a context indicator that tracks your active editor:

- **Eye icon + line count**: When you have code selected, shows "N lines"
- **Code icon + filename**: When a file is open without selection, shows the filename

Click the indicator to toggle whether the context is included in your next message. When enabled, the selected code (or entire file) is automatically injected into your prompt—no need to manually @mention or paste code.

### Image Attachments

Paste images directly into the chat input with `Ctrl+V` / `Cmd+V`:

- **Supported formats**: PNG, JPEG, GIF, WebP
- **Size limit**: 5MB per image
- **Max attachments**: 10 images per message

Attached images appear as thumbnails below the input. Hover over a thumbnail to reveal the remove button. Click any image in the conversation to open it in a lightbox.

#### @ Mention Autocomplete

- `@`: Trigger autocomplete popup for files and agents
- `↑` / `↓`: Navigate suggestions
- `Tab` / `Enter`: Insert selected item
- `Escape`: Close popup

**Mention types:**

| Syntax                   | Description                                  |
| ------------------------ | -------------------------------------------- |
| `@path/to/file.ts`       | Reference a workspace file                   |
| `@agent-Explore`         | Use the fast codebase exploration agent      |
| `@agent-Plan`            | Use the architecture planning agent          |
| `@agent-<name>`          | Use a custom agent from `.claude/agents/`    |
| `@agent-<plugin>:<name>` | Use an agent provided by an installed plugin |

Custom agents are loaded from `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user). Project agents override user agents with the same name. Plugin agents are loaded from enabled plugins' `agents/` directories.

#### Slash Command Autocomplete

- `/`: Trigger command autocomplete popup
- `↑` / `↓`: Navigate suggestions
- `Tab` / `Enter`: Insert selected command
- `Escape`: Close popup

**Built-in commands:**

| Command            | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `/clear`           | Clear conversation history                                             |
| `/compact`         | Compact conversation                                                   |
| `/rewind`          | Rewind conversation/code to a checkpoint                               |
| `/review`          | Request code review                                                    |
| `/security-review` | Security review of changes                                             |
| `/init`            | Initialize CLAUDE.md                                                   |
| `/remember <text>` | Save session memory (`project:` or `global:` prefix for broader scope) |
| `/note <text>`     | Save a persistent note to the knowledge base                           |
| `/memories`        | Open the memory management panel                                       |
| `/context`         | Display context usage breakdown                                        |
| `/batch`           | Decompose large changes into parallel background agents                |
| `/simplify`        | Review changed code for reuse, quality, and efficiency                 |

Custom commands are loaded from `.claude/commands/*.md` (project) and `~/.claude/commands/*.md` (user). Plugin commands use the format `/<plugin>:<command>` (e.g., `/myplugin:build`).

### Skills

Skills are specialized tools that extend Claude's capabilities. You can invoke skills in two ways:

**Via slash command (recommended):**

- Type `/skill-name` to invoke a skill directly - it appears in the autocomplete popup alongside regular commands
- Skills invoked this way are **auto-approved** (no approval prompt)
- Pass arguments after the skill name: `/skill-name additional context here`

**Via Claude's autonomous invocation:**

When Claude decides to use a skill on its own, you'll see an approval prompt:

- **Yes**: Approve this invocation (manual mode)
- **Yes, don't ask again**: Auto-approve this skill for the session
- **No**: Deny the skill
- **Tell Claude what to do instead**: Provide custom feedback

Skills are loaded from `.claude/skills/<name>/SKILL.md` (project) and `~/.claude/skills/<name>/SKILL.md` (user). Plugin skills use the format `/plugin:skill-name`. The skill description is parsed from the YAML frontmatter.

### Permission Rules

Define persistent allow/deny rules for tools in Claude Code CLI-compatible settings files. Rules are evaluated before each tool call and can automatically allow, deny, or prompt for specific patterns.

**Settings file priority (first match wins):**

| Priority | File                            | Scope                |
| -------- | ------------------------------- | -------------------- |
| 1        | `.claude/settings.local.json`   | Project (gitignored) |
| 2        | `.claude/settings.json`         | Project (shared)     |
| 3        | `~/.claude/settings.local.json` | User (private)       |
| 4        | `~/.claude/settings.json`       | User (shared)        |

**Example settings file:**

```json
{
  "permissions": {
    "allow": ["Bash(git:*)", "Bash(npm run *)"],
    "deny": ["Bash(rm:*)", "Bash(sudo:*)"],
    "ask": ["Bash(npm publish:*)"]
  }
}
```

**Pattern syntax:**

| Pattern           | Matches                                |
| ----------------- | -------------------------------------- |
| `Bash`            | All Bash commands                      |
| `Bash(git:*)`     | Commands starting with `git`           |
| `Bash(npm run *)` | Commands starting with `npm run `      |
| `Edit(*.ts)`      | Edit operations on `.ts` files         |
| `Write(src/**)`   | Write operations anywhere under `src/` |

**Quick rule creation:**

When a permission prompt appears, you can click "Always allow {pattern}" or "Always deny {pattern}" to create a persistent rule. A destination picker lets you choose which settings file to save the rule to (local, project, or global).

### Persistent Memory

Damocles gives Claude persistent memory that survives across compactions and sessions. Memories are stored locally in WASM-based SQLite (`~/.damocles/memory.db`) — no native modules, works on every platform without compilation.

**Memory tiers:**

| Tier         | Scope                | Auto-Injected             | How to Create                 |
| ------------ | -------------------- | ------------------------- | ----------------------------- |
| Session      | Current session      | Yes                       | `/remember <text>`            |
| Project      | Current workspace    | Yes (all sessions)        | `/remember project: <text>`   |
| Global       | All workspaces       | Yes (everywhere)          | `/remember global: <text>`    |
| Notes        | Knowledge base       | No (on-demand via search) | `/note <text>`                |
| Observations | Per-session activity | Recent 5 in context       | Claude voluntary via MCP tool |

**How the catalog works:**

Every prompt you send receives a relevance-ranked catalog of available memories. The catalog builder:

1. Runs FTS5 full-text search against your prompt to find relevant memories
2. Scores each memory using a composite signal:
   - **Prompt relevance** (50%): BM25 text similarity (FTS5 with porter stemming)
   - **Recency** (15%): How recently was the memory created/updated?
   - **Tier priority** (15%): Session > Project > Global > Observation > Note
   - **File proximity** (10%): Does the memory mention the file you have open?
   - **Retrieval boost** (10%): How often has Claude actively retrieved this memory?
3. Takes the top N entries per tier (entry-count limits, not token budgets)
4. Formats as a compact catalog: short text for session/project/global (truncated entries include ID for retrieval), title + ID for observations
5. Injects pinned memories as full content

When the prompt doesn't match any memories, scoring falls back to a recency-dominant heuristic. Claude browses the catalog and calls `get_memory_details` to retrieve full content for observations that look relevant to the current task.

**Example — catalog output:**

```xml
<damocles_memory>
<project_memories>
- JWT tokens expire after 1 hour. Refresh logic lives in auth-service.ts
- Database uses Knex with PostgreSQL. Migrations in db/migrations/
</project_memories>
<recent_observations>
- [obs-auth-uuid] Fixed authentication token refresh race condition (src/auth-service.ts)
- [obs-deploy-uuid] Deployment pipeline fix for staging environment
</recent_observations>
<pinned_memories>
- [mem-arch-uuid] Architecture: always use repository pattern for data access
  Full content of the pinned memory here...
</pinned_memories>
</damocles_memory>
```

Claude sees the catalog (~300-800 tokens) and decides what to retrieve. For complex problems, Claude naturally retrieves less. For context-heavy tasks, Claude pulls exactly what it needs.

**Smart session handoff:**

When you start a new session in the same workspace, the first message automatically includes:

- Top-ranked observations from recent sessions, scored by prompt relevance, file proximity, and recency

**MCP tools for Claude:**

Claude has 9 memory tools it can use autonomously:

- `save_observation` — Record structured observations after significant work
- `search_memories` — Full-text search returning a compact index (~30 tokens/result)
- `get_memory_details` — Fetch full content for specific memory IDs (also records retrievals for feedback)
- `get_timeline` — Chronological context window around an observation
- `save_note` / `list_notes` — Knowledge base management
- `reset_observation_staleness` — Mark an observation as fresh after verifying its content
- `pin_memory` / `unpin_memory` — Pin/unpin memories for guaranteed full-content injection

**Memory panel:**

Type `/memories` to open a 6-tab panel where you can browse, create, delete, and search across all memory tiers.

### Plugins

Plugins extend Claude's capabilities with additional agents and slash commands. Installed plugins are discovered from:

- **Registry**: `~/.claude/plugins/installed_plugins.json` (managed by Claude Code CLI)
- **Manual**: `<project>/.claude/plugins/*/` directories with `.claude-plugin/plugin.json`

Enable or disable plugins from the plugin status panel in the UI. Plugin settings are persisted to Claude's settings files.

**Plugin-provided features:**

| Feature        | Syntax                   | Example               |
| -------------- | ------------------------ | --------------------- |
| Agents         | `@agent-<plugin>:<name>` | `@agent-pdf:analyzer` |
| Slash commands | `/<plugin>:<command>`    | `/pdf:extract`        |

### Provider Profiles

Provider profiles allow you to define and switch between different API providers (Anthropic, Z.AI, OpenRouter, etc.) directly from the settings panel. Each profile stores environment variables that configure the SDK's connection.

**Security:** API credentials are encrypted using VS Code's SecretStorage API (backed by the OS keychain) and never stored in settings.json. Profile names are visible in settings, but all environment variables containing API keys are stored securely.

**Creating a profile:**

1. Open the settings panel (gear icon in chat header)
2. Scroll to "Provider Profiles" section
3. Click "Add Profile"
4. Enter a profile name and add environment variables

**Common environment variables:**

| Variable                         | Purpose                                   |
| -------------------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`             | Custom API endpoint URL                   |
| `ANTHROPIC_AUTH_TOKEN`           | API key or auth token for the provider    |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`   | Model name to use when Opus is selected   |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Model name to use when Sonnet is selected |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`  | Model name to use when Haiku is selected  |

**Example: Z.AI Profile**

```
Name: zai
ANTHROPIC_BASE_URL: https://api.zai.com/v1
ANTHROPIC_AUTH_TOKEN: your-zai-api-key
ANTHROPIC_DEFAULT_SONNET_MODEL: claude-sonnet-4-20250514
```

**Per-panel profiles:**

Each open panel can have its own provider profile independent of other panels. The settings panel shows two profile selectors:

- **This panel**: The provider profile for the current panel only
- **Default for new panels**: The global default that new panels inherit when opened

This allows you to have multiple panels open simultaneously, each connected to a different provider (e.g., one panel using OpenRouter while another uses Z.AI).

When you activate a profile, the session automatically restarts with the new provider configuration. Set to "Default" to use the Anthropic API with your `ANTHROPIC_API_KEY` environment variable.

**Per-panel models:**

Each open panel can also have its own model independent of other panels. The settings panel shows two model selectors:

- **This panel**: The model for the current panel's session (applies immediately)
- **Default for new panels**: The global default that new panels inherit when opened

Changing the default does not affect any existing panel's session — only new panels pick up the new default.

## Configuration

| Setting                                   | Description                                                                  | Default          |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| `damocles.permissionMode`                 | How to handle tool permissions (`default`, `acceptEdits`, `plan`)            | `default`        |
| `damocles.maxTurns`                       | Maximum conversation turns per session                                       | `100`            |
| `damocles.maxIndexedFiles`                | Maximum files to index for @ mention autocomplete                            | `5000`           |
| `damocles.providerProfiles`               | Array of provider profile names (credentials stored securely in OS keychain) | `[]`             |
| `damocles.activeProviderProfile`          | Currently active provider profile name                                       | `null`           |
| `damocles.contextStrategy`                | Default context strategy for new panels (`default` or `distill`)             | `default`        |
| `damocles.distillTokenBudget`             | Token budget for distill context retrieval per query (500–16000)             | `4000`           |
| `damocles.distillQueryDecomposition`      | Enable query decomposition for distill context retrieval using Haiku         | `true`           |
| `damocles.distillReranking`               | Enable semantic re-ranking of distill context retrieval using Haiku          | `false`          |
| `damocles.chrome.enabled`                 | Enable Chrome browser integration via the Chrome Extension MCP server        | `false`          |
| `damocles.voice.provider`                 | Speech-to-text provider (`openai-whisper`, `deepgram`, `google-cloud-stt`)   | `openai-whisper` |
| `damocles.voice.language`                 | Language code for voice transcription (e.g., `en`, `el`, `de`)               | `en`             |
| `damocles.autoCompact.enabled`            | Enable automatic context compaction at hard threshold                        | `true`           |
| `damocles.autoCompact.warningThreshold`   | Show warning indicator at this % of context usage                            | `60`             |
| `damocles.autoCompact.softThreshold`      | Show soft warning (red) at this % of context usage                           | `70`             |
| `damocles.autoCompact.hardThreshold`      | Trigger automatic `/compact` at this % of context usage                      | `75`             |
| `damocles.memory.enabled`                 | Enable persistent memory system                                              | `true`           |
| `damocles.memory.pinnedTokenBudget`       | Token budget for pinned memories                                             | `500`            |
| `damocles.memory.catalogObservationLimit` | Max observation entries in catalog                                           | `20`             |
| `damocles.memory.catalogProjectLimit`     | Max project memory entries in catalog                                        | `15`             |
| `damocles.memory.catalogGlobalLimit`      | Max global memory entries in catalog                                         | `10`             |

## Localization

The extension automatically uses VS Code's display language. Currently supported:

| Language | Code |
| -------- | ---- |
| English  | `en` |
| Greek    | `el` |

To change the language, set VS Code's display language via **Configure Display Language** command (`Ctrl+Shift+P` → "Configure Display Language").

## Requirements

- VS Code 1.95.0 or higher
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`)
- `ANTHROPIC_API_KEY` environment variable set (see Authentication below)

## Authentication

Damocles uses the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript), which uses Claude Code as its runtime. **The extension does not handle authentication directly** — it delegates entirely to Claude Code.

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Damocles Extension                               │
│         │                                               │
│         ▼                                               │
│  @anthropic-ai/claude-agent-sdk                         │
│         │                                               │
│         ▼ (uses as runtime)                             │
│  Claude Code                                            │
│         │                                               │
│         ▼ (handles authentication)                      │
│  Anthropic API                                          │
└─────────────────────────────────────────────────────────┘
```

The SDK uses Claude Code as its runtime. This means:

- All Claude Code authentication methods work automatically
- Sessions persist in `~/.claude/projects/`
- Tool execution, sandboxing, and permissions are handled by Claude Code

### Why Claude Code CLI Is Required

The Claude Agent SDK uses Claude Code as its runtime — it's not a standalone API client. Claude Code provides:

- **Built-in tools** — Bash, Read, Write, Edit, Grep, Glob, etc.
- **Authentication** — OAuth session management, API keys, cloud provider credentials
- **Session persistence** — Conversation history stored in `~/.claude/projects/`
- **Sandboxing** — OS-level process isolation for safe command execution
- **Permissions** — Tool approval workflows and permission modes

Your extension calls the SDK API; the SDK handles everything else through Claude Code.

### Setting Up Authentication

**Option 1: Claude Subscription (Recommended)**

If you have a Claude Pro, Max, Team, or Enterprise subscription and are logged into Claude Code, authentication works automatically — no API key or additional configuration needed. Claude Code handles the OAuth session, and Damocles inherits it at runtime.

To log in, run `claude` in your terminal and follow the prompts.

**Option 2: API Key**

```bash
export ANTHROPIC_API_KEY=your-api-key
```

Get your API key from the [Anthropic Console](https://console.anthropic.com/).

**Option 3: Cloud Providers**

For enterprise environments using cloud-hosted Claude:

| Variable                    | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `CLAUDE_CODE_USE_BEDROCK=1` | Use AWS Bedrock (requires AWS credentials)         |
| `CLAUDE_CODE_USE_VERTEX=1`  | Use Google Vertex AI (requires GCP credentials)    |
| `CLAUDE_CODE_USE_FOUNDRY=1` | Use Microsoft Foundry (requires Azure credentials) |

### Verifying Authentication

Once authenticated, the extension displays your account info (email, subscription type) in the chat panel header.

## Development

```bash
# Install dependencies
npm install

# Build extension and webview
npm run build

# Watch mode for development
npm run dev

# Type check
npm run typecheck
```

## Packaging

To create a distributable `.vsix` file:

```bash
npm run build && npm run package
```

This generates `damocles-<version>.vsix` which can be installed via:

- **VS Code UI**: Extensions → `...` menu → "Install from VSIX..."
- **Command line**: `code --install-extension damocles-<version>.vsix`

## Architecture

- **Extension Host** (Node.js): Handles Claude Agent SDK integration
- **Webview** (Vue 3 + Tailwind): Chat interface
- **postMessage Bridge**: Communication between extension and webview
