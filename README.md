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
- **Tool Overlays**: Click tool cards to view full output in a full-screen overlay — supports built-in tools (Bash, Read, Grep, Glob, WebFetch, WebSearch) with syntax highlighting or markdown rendering, and MCP tools with markdown output. Read overlays show a file metadata card with line range, total lines, and a progress bar for partial reads
- **Subagent Visualization**: Nested view of Task tool calls showing agent type, model, tool calls, and results
- **Streaming Responses**: Watch Claude's responses as they're generated
- **@ Mentions**: Type `@` to reference workspace files or agents (`@agent-Explore`, etc.) with fuzzy search autocomplete
- **Custom Agents**: Define custom agents in `.claude/agents/*.md` (project) or `~/.claude/agents/*.md` (user)
- **Image Attachments**: Paste images from clipboard directly into chat (supports PNG, JPEG, GIF, WebP up to 5MB)
- **IDE Context**: Automatically include the active file or selected code in your message (toggleable in input bar)
- **Slash Commands**: Type `/` for built-in commands (`/clear`, `/compact`, `/rewind`, etc.) and custom commands from `.claude/commands/`
- **Prompt History**: Navigate previous prompts with arrow keys (shell-style)
- **Session Management**: Create, rename, resume, delete, and search sessions with confirmation
- **Panel Persistence**: Panels and active sessions survive VS Code restarts
- **Multi-Panel Sync**: Prompt history syncs across all open panels instantly
- **Context Stats**: Live tracking of token usage, cache activity, context window %, and session cost
- **Session Logs**: Quick access button to open the raw JSONL session file (also works for subagent logs)
- **Model Selection**: Switch between Opus 4.6, Sonnet 4.5, and Haiku 4.5 with per-panel model selection and a separate workspace-wide default for new panels
- **Extended Thinking**: Toggle thinking mode on/off with adjustable token budget (1K-64K)
- **Per-Panel Permission Mode**: Each panel can have its own permission mode independent of the global default
- **YOLO Mode**: Toggle to auto-approve all tool calls (except plan approval and questions). Ephemeral setting that resets on session clear.
- **Custom Permission Rules**: Define persistent allow/deny rules for tools in Claude Code CLI-compatible settings files. Rules support pattern matching (e.g., `Bash(git:*)`, `Edit(*.ts)`). Permission prompts include "Always allow" and "Always deny" options that save rules to your chosen settings file.
- **Subagent-Scoped Accept All**: When you click "Accept all edits" on a subagent's permission prompt, only that subagent is auto-approved—the global session mode stays unchanged. Each subagent can be independently auto-approved without affecting the main session or other subagents.
- **Plan Mode**: When enabled, Claude creates implementation plans for your approval before making changes. Review plans in a modal, approve with auto-accept or manual mode, or request revisions with feedback. View session plan anytime via the header button
- **Clear Context & Auto-Accept**: Plan approval option that clears conversation context and starts fresh with the plan injected (matches Claude Code CLI behavior). Preserves planning session as reference while implementation runs in a clean session
- **Bind Plan to Session**: Inject a custom plan file into the session via the link icon in the header. Claude is notified of the plan file path so it can reference the plan.
- **File Checkpointing**: Track file changes and rewind to any previous state with the Rewind Browser (`/rewind`)
- **Task List**: Visual display of Claude's current tasks with status tracking, dependencies (`blockedBy`), and active form indicators
- **Message Queue**: Send messages while Claude is working - they're injected at the next tool boundary
- **Context Distillation (Beta)**: Alternative context strategy that replaces the SDK's built-in session resume with a per-session FTS5 database and a Haiku observer. Each panel independently chooses `default` or `distill` via "This panel" and "Default for new panels" dropdowns in the settings panel. The full lifecycle of a distill-mode turn:

  **1. Prompt submission** — The user message is persisted client-side to a JSONL file with a `parentUuid` chain (the SDK does not handle persistence in distill mode). Any pending Haiku observation from the previous turn is awaited via a wait-gate before proceeding. A fresh, stateless SDK query is created (`persistSession: false`) with a rotating `sessionId`, while a stable `persistenceSessionId` is used for the JSONL filename, database, and webview display.

  **2. Context injection** — The `UserPromptSubmit` hook fires before the query reaches the API. The context retriever runs an FTS5 full-text search (BM25-ranked) against the user's prompt on the session database and builds a two-layer result within a configurable token budget (`damocles.distillTokenBudget`, default 4000, range 500–16000, adjustable from the settings panel): *continuity* (the previous prompt's summary — always included to maintain conversational flow) and *relevant context* (BM25-matched entries from any earlier prompt, with related-file expansion, filled until the budget is exhausted). The result is injected as a `<distilled_session_context>` block in the SDK's `additionalContext` field, giving the stateless query awareness of the full session history without replaying it.

  **3. Stateless query execution** — The SDK query runs against the API with no prior conversation state. As Claude responds, an `EntryTracker` groups tool calls by file path (Read/Write/Edit/Glob/Grep), command (Bash), or web activity (WebSearch/WebFetch) into pending context entries. Each entry records the tool name and a one-line input summary. Assistant text and tool results are persisted to the session JSONL in real-time with `parentUuid` chaining. Subagent tool calls (from the Task tool) are routed to separate `agent-{id}.jsonl` files keyed by the parent `tool_use_id`, enabling full subagent overlay visualization for both live execution and history loading.

  **4. Haiku observation** — When the main response completes (including on user cancel), the `EntryTracker` finalizes — committing all pending entries to the per-session SQLite database (`~/.damocles/context/distill/{sessionId}.db`). A single Haiku query then fires with 4 in-process MCP tools: `list_prompt_entries` (read the auto-created entries), `update_entry_description` (annotate each with a description, search tags, and related file paths — triggering FTS5 index updates via SQL triggers), `mark_low_relevance` (exclude trivial entries from future retrieval), and `write_prompt_summary` (create a summary entry used as continuity context for the next turn). Haiku receives the user prompt and a summary of assistant activity, operates under a 30-second timeout, and its full turn log (thinking, text, MCP tool calls) is persisted to `prompt-{N}/haiku.jsonl` for debugging. The sparkles icon in the chat header opens the Haiku Observer overlay showing the observation per prompt with thinking, text output, and clickable MCP tool cards (opening full input/output overlays), prompt navigation, and buttons to open the raw log or context summary.

  **5. Next prompt** — The cycle repeats. The FTS5 query builder tokenizes the new user prompt, removes stopwords, and constructs an OR query of up to 16 quoted terms. BM25 ranking surfaces entries whose descriptions, tags, and file paths best match the query. Because context cost is bounded by the token budget (converted to characters at 4 chars/token), usage stays constant regardless of conversation length — a 50-turn session uses the same context window as a 5-turn session.
- **Auto-Compact**: Automatic context compaction via configurable thresholds (`damocles.autoCompact`). Visual warnings at `warningThreshold`/`softThreshold`, auto-triggers `/compact` at `hardThreshold` to prevent context overflow
- **Persistent Memory**: 5-tier memory system (session, project, global, notes, observations) stored in WASM-based SQLite. No native modules — works cross-platform without compilation. Memories survive compactions and sessions, giving Claude continuity across conversations. Prompt-aware context injection uses FTS5 full-text search to rank memories by relevance to your current question, combined with recency, tier priority, file proximity, and access frequency
- **Memory Commands**: `/remember <text>` saves session memory (prefix `project:` or `global:` for broader scope), `/note <text>` saves to a searchable knowledge base, `/memories` opens the management panel
- **Observations**: Claude voluntarily records rich observations via MCP tool after significant work — structured entries with type, title, narrative, facts, tags, and file paths. Zero additional API cost
- **Memory MCP Tools**: 6 in-process tools for Claude: `save_observation`, `search_memories`, `get_memory_details`, `get_timeline`, `save_note`, `list_notes`. Progressive disclosure keeps token usage efficient
- **Smart Session Handoff**: New sessions automatically receive the previous session's summary and top-ranked observations from recent sessions, weighted by file proximity to the active editor
- **Memory Panel**: 6-tab full-screen overlay (Session, Project, Global, Notes, Observations, Summaries) for browsing, creating, deleting, and searching memories
- **MCP Server Management**: Enable/disable MCP servers from the UI with settings persisted to Claude config
- **Hooks Support**: Claude Code hooks (shell commands that run on events like tool calls) work automatically
- **Plugins Support**: Enable/disable Claude Code plugins from the UI - plugins can provide agents and slash commands
- **Skills Support**: Approve or deny skill invocations
- **Provider Profiles**: Define and switch between API providers (Anthropic, Z.AI, OpenRouter, etc.) with per-panel profile selection
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

| Command            | Description                              |
| ------------------ | ---------------------------------------- |
| `/clear`           | Clear conversation history               |
| `/compact`         | Compact conversation                     |
| `/rewind`          | Rewind conversation/code to a checkpoint |
| `/review`          | Request code review                      |
| `/security-review` | Security review of changes               |
| `/init`            | Initialize CLAUDE.md                     |
| `/remember <text>` | Save session memory (`project:` or `global:` prefix for broader scope) |
| `/note <text>`     | Save a persistent note to the knowledge base |
| `/memories`        | Open the memory management panel         |

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

| Priority | File | Scope |
| --- | --- | --- |
| 1 | `.claude/settings.local.json` | Project (gitignored) |
| 2 | `.claude/settings.json` | Project (shared) |
| 3 | `~/.claude/settings.local.json` | User (private) |
| 4 | `~/.claude/settings.json` | User (shared) |

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

| Pattern | Matches |
| --- | --- |
| `Bash` | All Bash commands |
| `Bash(git:*)` | Commands starting with `git` |
| `Bash(npm run *)` | Commands starting with `npm run ` |
| `Edit(*.ts)` | Edit operations on `.ts` files |
| `Write(src/**)` | Write operations anywhere under `src/` |

**Quick rule creation:**

When a permission prompt appears, you can click "Always allow {pattern}" or "Always deny {pattern}" to create a persistent rule. A destination picker lets you choose which settings file to save the rule to (local, project, or global).

### Persistent Memory

Damocles gives Claude persistent memory that survives across compactions and sessions. Memories are stored locally in WASM-based SQLite (`~/.damocles/memory.db`) — no native modules, works on every platform without compilation.

**Memory tiers:**

| Tier | Scope | Auto-Injected | How to Create |
| --- | --- | --- | --- |
| Session | Current session | Yes | `/remember <text>` |
| Project | Current workspace | Yes (all sessions) | `/remember project: <text>` |
| Global | All workspaces | Yes (everywhere) | `/remember global: <text>` |
| Notes | Knowledge base | No (on-demand via search) | `/note <text>` |
| Observations | Per-session activity | Recent 5 in context | Claude voluntary via MCP tool |
| Auto-Summary | Per-workspace | Once after compaction | Automatic on `/compact` |

**How context injection works:**

Every prompt you send is enriched with relevant memories. The injection manager runs an FTS5 full-text search against your prompt to find semantically relevant memories, then scores each using a composite signal:
- **Prompt relevance** (40%): BM25 text similarity between your prompt and the memory (FTS5 with porter stemming)
- **Recency** (25%): How recently was the memory created/updated?
- **Tier priority** (15%): Session > Project > Global > Observation > Note
- **File proximity** (10%): Does the memory mention the file you have open?
- **Access frequency** (10%): How often has this memory been referenced?

When the prompt doesn't match any memories (e.g., generic greetings or image-only messages), scoring falls back to a recency-dominant heuristic. Each tier has its own independent token budget (configurable in settings), ensuring no tier can starve another.

Observations are injected as compact title + ID lines (e.g., `- [abc123] Fixed auth race condition (src/auth-service.ts)`). When an observation looks relevant, Claude calls `get_memory_details` with the ID to retrieve the full narrative, facts, and implementation details on demand.

**Example — full pipeline trace:**

Assume your database has these memories after a few days of work:

| ID | Tier | Content | Age |
|----|------|---------|-----|
| mem-jwt | project | "JWT tokens expire after 1 hour. Refresh logic lives in auth-service.ts" | 3 days |
| mem-knex | project | "Database uses Knex with PostgreSQL. Migrations in db/migrations/" | 2 days |
| mem-css | project | "Renamed CSS class from .header-old to .header-main" | 1 hour |
| mem-vitest | project | "Unit tests use vitest with 80% coverage threshold" | 1 day |
| obs-auth | observation | title: "Fixed authentication token refresh race condition" | 2 days |

You type: **"the refresh token is broken again"**

```
Step 1 — Stopword filter + FTS5 query building
  Split:            ["the", "refresh", "token", "is", "broken", "again"]
  Remove stopwords:  ["refresh", "token", "broken", "again"]    ← "the", "is" removed
  FTS5 query:       "refresh" OR "token" OR "broken" OR "again"

Step 2 — BM25 full-text search (single query across all tiers)
  FTS5 MATCH returns raw ranks:
    mem-jwt   → |rank| = 2.1   (matches "refresh", "token" in content)
    obs-auth  → |rank| = 3.8   (matches "refresh", "token" in content + facts)
    No match: mem-knex, mem-css, mem-vitest

Step 3 — Per-tier normalization + composite scoring
  PROJECT TIER (budget: 800 tokens):
    normalizeForTier filters to project IDs → only mem-jwt matched → score 1.0
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ mem-jwt:    fts=1.0×0.4 + recency=0.25×0.25 + tier=0.8×0.15 = 0.583  ← #1  │
    │ mem-css:    fts=0.0×0.4 + recency=0.96×0.25 + tier=0.8×0.15 = 0.360  ← #2  │
    │ mem-vitest: fts=0.0×0.4 + recency=0.50×0.25 + tier=0.8×0.15 = 0.245  ← #3  │
    │ mem-knex:   fts=0.0×0.4 + recency=0.33×0.25 + tier=0.8×0.15 = 0.203  ← #4  │
    └────────────────────────────────────────────────────────────────────────────────┘

  OBSERVATION TIER (budget: 500 tokens):
    normalizeForTier filters to observation IDs → only obs-auth matched → score 1.0
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ obs-auth:   fts=1.0×0.4 + recency=0.33×0.25 + tier=0.5×0.15 = 0.558  ← #1  │
    └────────────────────────────────────────────────────────────────────────────────┘

Step 4 — Budget-constrained selection + rendering
  Each memory's token cost is estimated from its rendered output.
  Observations render as title + ID only (~26 tokens), not full content (~280 tokens).

Step 5 — Final injected context (prepended to your message)
```
```xml
<damocles_memory>
<project_memories>
- JWT tokens expire after 1 hour. Refresh logic lives in auth-service.ts
- Renamed CSS class from .header-old to .header-main
- Unit tests use vitest with 80% coverage threshold
- Database uses Knex with PostgreSQL. Migrations in db/migrations/
</project_memories>
<recent_observations count="1">
- [obs-auth-uuid] Fixed authentication token refresh race condition (src/auth-service.ts)
</recent_observations>
</damocles_memory>
```

The JWT memory ranks **first** because FTS5 matched "refresh" and "token" in your prompt. Claude sees it at the top and gets the relevant context immediately.

Now you type: **"hi"**

```
  FTS5 query: "hi" (length 2, not a stopword) → 0 matches → fallback scoring
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │ mem-css:    file=0×0.4 + recency=0.96×0.3 + tier=0.8×0.2 = 0.448     ← #1  │
  │ mem-vitest: file=0×0.4 + recency=0.50×0.3 + tier=0.8×0.2 = 0.310     ← #2  │
  │ mem-knex:   file=0×0.4 + recency=0.33×0.3 + tier=0.8×0.2 = 0.259     ← #3  │
  │ mem-jwt:    file=0×0.4 + recency=0.25×0.3 + tier=0.8×0.2 = 0.235     ← #4  │
  └────────────────────────────────────────────────────────────────────────────────┘
```

Same 4 memories, completely different ranking. Generic prompt → recency wins. The CSS rename (1 hour old) ranks first. No regression from the pre-FTS5 behavior.

**Smart session handoff:**

When you start a new session in the same workspace, the first message automatically includes:
- Top-ranked observations from recent sessions, scored by prompt relevance, file proximity, and recency

**MCP tools for Claude:**

Claude has 6 memory tools it can use autonomously:
- `save_observation` — Record structured observations after significant work
- `search_memories` — Full-text search returning a compact index (~30 tokens/result)
- `get_memory_details` — Fetch full content for specific memory IDs
- `get_timeline` — Chronological context window around an observation
- `save_note` / `list_notes` — Knowledge base management

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

| Setting                          | Description                                                                  | Default   |
| -------------------------------- | ---------------------------------------------------------------------------- | --------- |
| `damocles.permissionMode`        | How to handle tool permissions (`default`, `acceptEdits`, `plan`)            | `default` |
| `damocles.maxTurns`              | Maximum conversation turns per session                                       | `100`     |
| `damocles.maxIndexedFiles`       | Maximum files to index for @ mention autocomplete                            | `5000`    |
| `damocles.providerProfiles`      | Array of provider profile names (credentials stored securely in OS keychain) | `[]`      |
| `damocles.activeProviderProfile` | Currently active provider profile name                                       | `null`    |
| `damocles.contextStrategy`       | Default context strategy for new panels (`default` or `distill`)             | `default` |
| `damocles.distillTokenBudget`    | Token budget for distill context retrieval per query (500–16000)             | `4000`    |
| `damocles.autoCompact.enabled`   | Enable automatic context compaction at hard threshold                        | `true`    |
| `damocles.autoCompact.warningThreshold` | Show warning indicator at this % of context usage                     | `60`      |
| `damocles.autoCompact.softThreshold`    | Show soft warning (red) at this % of context usage                    | `70`      |
| `damocles.autoCompact.hardThreshold`    | Trigger automatic `/compact` at this % of context usage               | `75`      |
| `damocles.memory.enabled`               | Enable persistent memory system                                       | `true`    |
| `damocles.memory.sessionTokenBudget`    | Token budget for session memories in context                          | `1000`    |
| `damocles.memory.projectTokenBudget`    | Token budget for project memories in context                          | `800`     |
| `damocles.memory.globalTokenBudget`     | Token budget for global memories in context                           | `500`     |
| `damocles.memory.observationTokenBudget`| Token budget for observations in context                              | `500`     |

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
