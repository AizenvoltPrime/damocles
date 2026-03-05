# Changelog

All notable changes to Damocles will be documented in this file.

## [1.1.45] - 2026-03-05

### Fixed

- **Plan Binding in Default Mode**: Replaced the async hook-deferred `pendingPlanBind` mechanism with direct post-`sendMessage` plan file creation. The previous approach fired plan writes from `PostToolUse`/`Stop` hooks, but `closeAndReset()` aborted the controller before the hooks' async writes could complete, so the plan file was never created. Now the handler enters plan mode to trigger slug generation, awaits `sendMessage`, reads the slug from session metadata, and writes the plan file at `~/.claude/plans/${slug}.md` — all in a synchronous control flow that cannot be interrupted
- **Plan Binding Distill Detection**: `bindPlanToSession` now uses the live `isDistillMode` getter instead of serialized JSONL metadata, which returns null for sessions with no messages and caused the wrong code path to execute
- **Context Distillation First-Prompt Waste**: Added `promptIndex > 0` guard to Haiku query decomposition — the 60-second decomposition result on the first prompt was immediately discarded since `retrieveContext` returns null for `promptIndex <= 0`

### Removed

- **`pendingPlanBind` Subsystem**: Deleted the `_pendingPlanBind` field, `setPendingPlanBind`/`getPendingPlanBind`/`clearPendingPlanBind` methods, `bindPlanWhenSlugAvailable` polling retry loop (30×500ms), two hook blocks in `PostToolUse` and `Stop`, and three `HookDependencies` interface members

## [1.1.44] - 2026-03-04

### Added

- **Chrome Browser Integration**: Built-in MCP server for Chrome browser automation — take screenshots, execute JavaScript, click elements, navigate pages, and interact with web content directly from the chat. Disabled by default; toggle from the MCP status panel or via the `damocles.chrome.enabled` setting. Requires the Claude Code Chrome Extension. Chrome appears as a named entry in the MCP panel alongside external MCP servers, with dedicated `ChromeManager` sub-manager for state persistence and SDK status merging. `displayName` field added to `McpServerStatusInfo` for flexible server naming in the UI
- **MCP Tool Image Rendering**: MCP tool overlays now extract and render base64 image blocks (PNG, JPEG, GIF, WebP) from JSON-stringified tool results. Shared `imageUtils.ts` utility with `imageBlockToDataUrl()` converter and `isImageContentBlock()` runtime type guard. `McpToolOverlay.vue` returns structured `{ textContent, images }` from parsed results, renders image thumbnails in a flex gallery, and integrates `ImageLightbox` for fullscreen viewing. Supports image-only results (no text). `MessageList.vue` refactored to use the shared utility

### Changed

- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` upgraded from `0.2.63` to `0.2.68`

## [1.1.43] - 2026-03-02

### Added

- **Batch Command Support**: Enabled the `/batch` command that decomposes large-scale changes into 5–30 independent units, spawns parallel background agents in isolated git worktrees, and has each agent create a PR. Direct prompt injection path bypasses the Skill tool for `disableModelInvocation` commands
- **Background Task Enablement**: Removed the `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` env var guard that prevented the SDK from exposing `run_in_background` on the Agent tool schema — the task lifecycle infrastructure (`taskStarted`/`taskNotification` streaming processors) is production-ready
- **Orchestration Permissions**: Added `ORCHESTRATION_TOOLS` permission category that auto-approves the Agent tool at the orchestration layer while child agents' individual tool calls still face independent permission evaluation
- **Worktree Hooks**: Added `WorktreeCreate`/`WorktreeRemove` hook handlers for observability during batch operations

## [1.1.42] - 2026-02-28

### Added

- **Remote Control (REPL Bridge)**: Full-stack UI for the SDK's hidden `enableRemoteControl()` WebSocket method. `RemoteControlManager` uses a type guard pattern to safely consume the untyped SDK method without `as any` casts. A post-query-created hook in `QueryManager` reapplies remote control state across query recreations (model change, MCP restart). Webview includes `RemoteControlIndicator` component with Popover toggle, state-based icon coloring (green active, muted inactive), connection status display, and per-URL copy buttons. Pinia store manages lifecycle with enable/disable/status message handlers

## [1.1.41] - 2026-02-28

### Fixed

- **Haiku Wait Gate Dual-Path Bypass**: Moved the Haiku wait gate from `ClaudeSession.sendMessage()` to the `UserPromptSubmit` hook handler, co-locating the guard with the FTS5 read it protects (`getDistilledContext`). Previously, queued prompts submitted via the turn-end flush path (`flushQueuedMessagesAsNewTurn` → `_streamingInputController.sendMessage()`) bypassed the wait entirely, causing the new turn to read stale distilled context before Haiku finished annotating. The hook is the convergence point for all user turns — normal prompts, queue-flushed messages, and any future submission paths — so a single gate now covers everything.

## [1.1.40] - 2026-02-28

### Fixed

- **Subagent Tool Guard**: PostToolUse hook now detects subagent tools via `isSubagentTool()` (checks `parentToolUseId` in `streamedToolIds`) and returns early before main-instance logic runs — prevents plan mode activation, queue injection, and other side effects from triggering on subagent tool completions
- **Parallel Agent Queue Injection**: Queue injection now defers until the last parallel Agent tool completes. `hasActiveAgentTools()` scans `streamedToolIds` for remaining `TOOL_AGENT` entries, preventing partial message injection while agents are still in-flight

## [1.1.39] - 2026-02-28

### Added

- **Dismiss & Return to Plan Approval**: Pressing Escape on the plan approval overlay now hides it instead of canceling the plan. The ExitPlanModeToolCard becomes clickable with a pulsing accent ring, showing "Click to review plan" — clicking it re-opens the overlay with the same plan content. A second Escape in chat cancels the plan entirely. This prevents accidental plan rejections during review
- **Context Usage Badge in Plan Approval Overlay**: The plan approval overlay header shows a colored badge with the current context window usage percentage. Uses threshold-based colors from auto-compact settings (green → amber → orange → rose) so users can make an informed decision when choosing "Clear Context & Accept"

### Fixed

- **Plan Reentry Tool Status**: The `requestPlanApproval` handler was not updating the tool status to `awaiting_approval`, preventing the ExitPlanModeToolCard from becoming clickable after dismissing the overlay

## [1.1.38] - 2026-02-28

### Fixed

- **SDK Skills Missing from Autocomplete**: `/simplify` and `/batch` were not appearing in the slash command autocomplete because the SDK wasn't initialized when the webview cached the command list (race condition). Replaced over-engineered dynamic discovery approach with a simple static solution — added both commands to `BUILTIN_SLASH_COMMANDS` and created an `SDK_SKILL_NAMES` set for pre-approval in the skill detection path

## [1.1.37] - 2026-02-28

### Fixed

- **SDK Agent Tool Rename**: SDK v0.2.63 renamed the subagent tool from `"Task"` to `"Agent"`. Updated all 14 string comparisons across 12 files to use `TOOL_AGENT` constant, fixing broken subagent card rendering, overlay display, and history restoration

### Added

- **Context Usage Overlay**: Full-screen overlay showing detailed context window analysis via the `/context` slash command or the "View Details" button in the SessionStats popover. Features an SVG ring chart with color-coded usage thresholds, a stacked category bar, per-category breakdown with individual progress bars (System Prompt, System Tools, MCP Tools, Custom Agents, Memory Files, Skills, Messages, Compact Buffer, Free Space), and collapsible detail sections for MCP tools, memory files, skills, and custom agents. New `context-usage-parser.ts` reverse-engineers the SDK's `/context` markdown output into structured `ContextUsageData`. A `local-command-processor` intercepts `system:local_command_output` stream events for content-based routing. Pinia store manages overlay lifecycle with loading, busy, and parse-failure states. Full i18n support (en/el)

### Changed

- **Centralized Tool Names**: Extracted ~80 hardcoded tool name strings across 15+ files into a single shared module (`src/shared/tool-names.ts`). Individual constants (`TOOL_READ`, `TOOL_WRITE`, `TOOL_AGENT`, etc.) and derived groupings (`FILE_TOOLS`, `WRITE_TOOLS`, `READ_ONLY_TOOLS`, `IGNORED_TOOLS`, `TASK_MANAGEMENT_TOOLS`) provide compile-time safety against future SDK renames
- **Wire Format Rename**: `subagentModelUpdate.taskToolId` and `subagentMessagesUpdate.taskToolId` renamed to `agentToolId` in message types and all producers/consumers
- **Internal Variable Renames**: `pendingTaskToolIds` → `pendingAgentToolIds`, `registerTaskTool()` → `registerAgentTool()`, `isTaskToolWithSubagent()` → `isAgentToolWithSubagent()`, `extractTaskResultTexts()` → `extractAgentResultTexts()` — disambiguates the Agent tool from TaskCreate/TaskUpdate tools

### Removed

- **Dead Code**: Deleted `ContextUsagePanel.vue` — superseded by the new `ContextUsageOverlay.vue` with full-featured overlay UI

## [1.1.36] - 2026-02-28

### Fixed

- **Observation Scoping in Memory Panel**: Observations are now workspace-scoped in the panel instead of session-scoped. Previously, `getAllMemories` filtered observations by `sessionId` first, hiding all observations from prior sessions. The `session_id` column is provenance metadata (which session recorded the observation), not a lifecycle owner
- **Session Deletion Preserves Observations**: `deleteSessionMemories` no longer cascades to observations. Deleting a chat session from history previously destroyed all observations recorded during that session — permanent loss of project-level knowledge. Only session-tier memories are now cleaned up

### Added

- **Pin/Unpin UI in Memory Panel**: All memory card templates (Session, Project, Global, Notes, Observations) now show a pin toggle button on hover — `Pin` icon to pin, `PinOff` icon (amber) to unpin. Pinned cards display an amber left-border accent (`border-l-2 border-l-amber-500`). Events wired through `App.vue` to the existing `pinMemory`/`unpinMemory` message handlers, which trigger a toast and refresh the panel

### Removed

- **Dead Code**: Removed `MemoryService.getRecentObservations()`, `ObservationManager.getRecent()`, and `ObservationManager.deleteBySession()` — all orphaned after the scoping and lifecycle fixes

## [1.1.35] - 2026-02-27

### Changed

- **Pull-First Memory Architecture**: Replaced the push-based budget/scoring/confidence pipeline with a pull-first catalog model. Instead of auto-selecting and injecting full memory content (~2800 tokens), the system now injects a compact relevance-ranked catalog (~300-800 tokens) of titles and short entries, letting Claude decide what to retrieve via `get_memory_details`. Session/project/global memories appear as short text; observations appear as compact title + ID lines. This eliminates token displacement from irrelevant injection, unpredictable context shifts, and the system trying to outsmart Claude on what's relevant
- **Scoring Formula**: Replaced `accessBoost` (based on auto-injection count) with `retrievalBoost` (based on Claude's active `get_memory_details` calls). Creates a genuine feedback loop: catalog ranking improves based on what Claude actually finds useful
- **Entry-Count Limits**: Replaced per-tier token budgets with entry-count limits (session: all, project: 15, global: 10, observations: 20). Configurable via `damocles.memory.catalog*` settings
- **System Prompt**: Updated `<auto_injected_context>` to describe the catalog model — emphasizes browse-first retrieval and pinned memories
- **Database Schema V4**: Added `pinned` column to memories table, new `memory_retrievals` table for tracking Claude's retrieval patterns
- **Memory Tab Overlay**: Simplified to show catalog entries with scores, pinned section with full content, and retrieval boost indicators. Removed budget/confidence/expansion badges

### Added

- **Pinned Memories**: User-designated memories that bypass the catalog and are always injected in full content. MCP tools `pin_memory`/`unpin_memory` for Claude, pin/unpin message protocol for the webview overlay. Configurable budget via `damocles.memory.pinnedTokenBudget` (default 500 tokens)
- **Retrieval Tracking**: `memory_retrievals` table records when Claude calls `get_memory_details`, with a 30-day lookback window. Retrieval counts inform catalog ranking via a log-saturating boost function, implementing a closed MemR³ feedback loop
- **Content Truncation Safety**: Session/project/global entries exceeding 300 characters are truncated to `[id] preview...[Use get_memory_details for full content]`, preserving the memory ID so Claude can retrieve the full content on demand

### Removed

- **Per-Tier Token Budgets**: `damocles.memory.sessionTokenBudget`, `projectTokenBudget`, `globalTokenBudget`, `observationTokenBudget` settings removed
- **Query Expansion for Injection**: `damocles.memory.queryExpansion` setting removed (expansion remains available for the distill system's index-time term generation)
- **RetrievalConfidenceTracker for Injection**: No longer used in memory injection pipeline (kept for distill system)
- **Budget Scaling**: `scaleBudgets()`, `selectByBudget()` token-greedy selection functions replaced by `selectTopN()` entry-count selection

## [1.1.34] - 2026-02-27

### Added

- **Memory Injection Persistence**: Memory tab injection data is now durably stored in per-session SQLite databases (`~/.damocles/context/memory/{sessionId}.db`) so the transparency overlay survives context compactions and history reloads. New `injection-database.ts` provides versioned schema with migrations. `InjectionManager` manages per-session DB lifecycle with lazy open and cleanup on dispose. `QueryManager` uses a write-through cache pattern — writes to both the in-memory Map and DB on injection, reads check Map first then fall through to DB on cache miss (history load scenario)

### Changed

- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` bumped from `0.2.59` to `0.2.61`

### Fixed

- **Session Memory ID Stability**: Memory operations in distill mode were using the rotating `streamingManager.sessionId` (which changes with every SDK query) instead of the stable `persistenceSessionId`, causing session-scoped memories, first-message tracking, and MCP session identification to be orphaned across prompts. Replaced all 4 memory call sites with a `getMemorySessionId` callback injected into `QueryManager`, routed through `ClaudeSession.memorySessionId` which now resolves to `persistenceSessionId`
- **Context Injection Overlay Tab Styling**: Tab buttons ("Distill Context" / "Memory") lacked pointer cursor and caused layout shift when switching — the active state added a `border` that the inactive state lacked, changing box geometry by 2px. Moved `border` into base classes with `border-transparent` default so active/inactive only toggles color, never size

## [1.1.33] - 2026-02-26

### Added

- **Observation Staleness Tracking**: New `FileChangeTracker` manager builds a reverse index from file paths to observations and listens to `onDidSaveTextDocument`. When a tracked file is saved (debounced 5s), the `file_change_count` is incremented in the database. Observations with high change counts are marked `[stale]` in injection context, prompting Claude to verify their content. New `reset_observation_staleness` MCP tool lets Claude mark observations as fresh after verification
- **Query Expansion**: Haiku-powered bidirectional vocabulary expansion for memory FTS5 retrieval, enabled by default in `adaptive` mode. Index-time expansion (`expandMemoryTerms`) generates synonyms and related search keywords when memories are saved, stored in a new `search_terms` column and included in the FTS5 index. Query-time expansion (`expandQuery`) generates alternative search terms as a fallback when first-pass BM25 results are poor. Configurable via `damocles.memory.queryExpansion` (off/`adaptive` default/always)
- **Retrieval Confidence Backoff**: New `RetrievalConfidenceTracker` tracks FTS score distributions over time in the `fts_score_history` table, computes percentile-based confidence scores, and dynamically scales token budgets (0.25×–1.0×) based on query quality. Shared by both memory injection and distill context retrieval
- **Memory Injection Transparency**: The context injection overlay now includes a Memory tab showing per-tier injection details (budget, effective budget, tokens used, entries with full score breakdowns), FTS query terms, expanded terms, confidence multiplier, and expansion decision metadata. `QueryManager` tracks memory injection metadata per prompt index via `MemoryInjectionDisplay`
- **Shared SDK Loader**: Extracted `loadSdkQuery()` to `shared/sdk-loader.ts` for reuse by both memory query expansion and distill annotation/reranking/decomposition

### Changed

- **Memory Injection Pipeline**: `InjectionManager.buildInjectionContext` now returns metadata alongside the context string, with unified `ScoredMemory` tracking for per-entry score breakdowns. `HookDependencies.getMemoryContext` changed from sync to async to support Haiku query expansion
- **Independent Per-System Budgets**: Removed `totalInjectionBudget` cross-system orchestration where distill could starve memory. Distill now uses its own `distillTokenBudget`, memory uses its per-tier budgets (session/project/global/observation), each scaled only by retrieval confidence — no cross-system coupling
- **Database Schema V3**: Added `file_change_count` and `search_terms` columns to memories table, new `fts_score_history` table for retrieval confidence tracking, and updated FTS5 virtual table with search_terms field and refreshed triggers
- **Context Injection Overlay**: Expanded from distill-only to universal — the pill button now appears for all user messages. Added tabbed UI (Distill | Memory) when both systems have data, with per-tier entry cards, score breakdowns, and expansion info

## [1.1.32] - 2026-02-22

### Fixed

- **Output Channel Focus Stealing**: The unconditional `showLog()` call during activation no longer steals editor focus on every window load. Log output is now only auto-shown when `damocles.debug` is enabled

### Added

- **Show Log Command**: New `damocles.showLog` command for on-demand log access via the Command Palette, with localized titles (EN/EL)

## [1.1.31] - 2026-02-21

### Changed

- **Model Capability Discovery**: Replaced all hardcoded `isAdaptiveCapable()` regex checks with runtime SDK-provided `ModelInfo` properties (`supportsAdaptiveThinking`, `supportsEffort`, `supportedEffortLevels`). `buildThinkingOptions()` now accepts `ModelInfo` instead of a model string. `DEFAULT_MODELS` in `constants.ts` pre-populates capability data so the settings panel works before the SDK responds. Effort level options are now data-driven from `supportedEffortLevels` instead of hardcoded `<SelectItem>` elements
- **Model Switching**: `setModel()` changed from async `query.setModel()` (which silently failed) to sync `closeAndReset()` pattern — closes the current query so the next message recreates it with the new model, matching the proven pattern used by `setPermissionMode()` and `restartForMcpChanges()`

### Added

- **MCP Reconnect & Authenticate**: New `reconnectMcpServer` and `authenticateMcpServer` message handlers with SDK `query.reconnectMcpServer()` integration. MCP status panel shows "Reconnect" button for failed servers and "Authenticate" button for `needs-auth` servers
- **MCP Error Display**: Failed MCP servers now show their error message directly in the status panel
- **MCP Tool Listing**: MCP status panel shows per-server tool counts with expandable tool details — each tool displays its name, description, and annotation badges (read-only, destructive, network)
- **MCP Status Enrichment**: `McpManager.sendStatus()` now forwards `error` and `tools` data from the SDK alongside existing `serverInfo`, with a new `McpToolInfo` type in `shared/types/mcp.ts`

## [1.1.30] - 2026-02-21

### Added

- **Subagent Last Assistant Message**: The SDK's `last_assistant_message` from `SubagentStop` and `Stop` hooks is now threaded through the extension → webview pipeline. For subagents, it serves as a fallback when `result.content` is empty (interrupted or failed agents) — the `SubagentOverlay` displays it via `resultContent` computed property. For the main session, it's stored on `useSessionStore.lastAssistantMessage` for future session resume previews. Includes a new `ToolManager.getToolUseIdForAgent()` reverse lookup so the `SubagentStop` message carries the correct `toolUseId` for direct store keying
- **Permission Context**: `blockedPath` and `decisionReason` from the SDK's `canUseTool` callback are now forwarded through the 8-boundary type chain (query-manager → tool-manager → permission-handler → approval-manager → message types → permission store → `PermissionPrompt.vue`) and rendered as muted secondary text below the command/file path in permission prompts
- **ConfigChange Hook**: Registers the SDK's `ConfigChange` lifecycle hook. When settings files change mid-session (`.claude/settings.json`, skills, etc.), a toast notification informs the user with the source label (User settings, Project settings, Local settings, Policy settings, Skills)

## [1.1.29] - 2026-02-21

### Changed

- **Streaming Processor Architecture**: Refactored `ProcessorRegistry` from a fixed typed interface with switch-case dispatch to a map-based registry with composite keys (e.g., `system:status`, `system:task_started`). Adding new SDK message types no longer requires interface or switch changes — just register a processor in the map. Moved `budgetLimit` from a per-call `TExtra` generic parameter to `StreamingState`, eliminating the `MessageProcessor<TExtra>` generic entirely. Moved stale query detection into the `consumeQueryInBackground` iteration loop for per-message staleness checks
- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` bumped from `0.2.45` to `0.2.50`

### Added

- **Status Processor** (Phase 1.2): Handles SDK `system:status` messages — forwards compacting indicator and permission mode changes to the webview
- **Task Lifecycle Processor** (Phase 1.3): Handles `system:task_started` and `system:task_notification` — pre-registers tasks before the `SubagentStart` hook fires, and forwards completion/failure with `tool_use_id` correlation and usage stats
- **Tool Events Processor** (Phase 1.4): Handles `tool_progress` and `tool_use_summary` — forwards elapsed time per tool call and tool use summaries to the webview
- **Session Events Processor** (Phase 1.5): Handles `system:auth_status`, `system:files_persisted`, and hook lifecycle events (`hook_started`, `hook_progress`, `hook_response`) — forwards auth state, file persistence results, and hook execution status
- **stop_reason Extraction** (Phase 1.6): `ResultMessage` now carries `stop_reason` from the SDK result, forwarded to `useStreamingStore` for downstream consumption
- **Webview message types**: `statusUpdate`, `taskStarted`, `taskNotification`, `toolProgress`, `toolUseSummary`, `authStatusUpdate`, `filesPersisted`, `hookLifecycle` added to `ExtensionToWebviewMessage`
- **Store state**: `useUIStore` gains `isCompacting` and `activeHooks`; `useSettingsStore` gains `authStatus`; `useStreamingStore` gains `lastStopReason` and tool elapsed time/summary tracking; `ToolCall` gains `elapsedTimeSeconds` and `summary` fields

## [1.1.28] - 2026-02-18

### Changed

- **Adaptive Thinking & Reasoning Effort**: Model-aware thinking configuration that uses the correct SDK API per model family. 4.6 models (Opus 4.6, Sonnet 4.6) now use `thinking: { type: 'adaptive' }` with a configurable `effort` level (Low / Medium / High / Max) — replacing the deprecated `maxThinkingTokens`. Legacy models (Opus 4.5, Haiku) retain the existing toggle + budget UI with `thinking: { type: 'enabled', budgetTokens }`. The settings panel auto-detects the active model and shows the appropriate controls. A "Disable thinking" toggle is available for 4.6 models to switch to `thinking: { type: 'disabled' }`. Plan injection sites now use a thinking override mechanism (`disableThinkingForNextQuery` / `restoreThinkingConfig`) that closes and recreates the query with the correct thinking config, replacing the deprecated `setMaxThinkingTokens()` runtime setter which had no effect on adaptive models. Permission mode is tracked in `QueryManager._currentPermissionMode` and reapplied after query recreation so plan mode's permission state is preserved across the close/recreate cycle.

### Added

- **VS Code settings**: `damocles.effort` (reasoning effort for adaptive models) and `damocles.thinkingDisabled` (disable adaptive thinking)

## [1.1.27] - 2026-02-17

### Changed

- **AskUserQuestion Enter-to-Save**: Custom input in the AskUserQuestion popup now saves on bare **Enter** (previously required Ctrl+Enter), with **Shift+Enter** for newlines — aligning with the established input pattern used in `ChatInput.vue` and the base `Textarea.vue` component

## [1.1.26] - 2026-02-17

### Changed

- **Model Upgrade — Sonnet 4.6**: Replaced all references to Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) with Sonnet 4.6 (`claude-sonnet-4-6`) across the codebase — model selector (`SettingsPanel.vue`), i18n locales (EN/EL), VS Code NLS configuration files, README, and all SDK documentation (`streaming.md`, `session-management.md`, `beta-headers.md`, `permission-settings.md`, `slash-commands-sdk.md`, `agents-sdk.md`). The new model ID drops the date suffix, matching the pattern established by `claude-opus-4-6`. The 1M extended context regex (`/claude-sonnet-4/`) is version-agnostic and required no change
- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` bumped from `0.2.42` to `0.2.45`

## [1.1.25] - 2026-02-16

### Added

- **Voice Input**: Microphone button in the chat input bar for speech-to-text transcription. Click to start recording, click again to stop and transcribe. Visual states show recording (pulsing red ring), starting (spinner), and transcribing progress. Audio is captured extension-side via native platform APIs — Windows (PowerShell + winmm.dll MCI), macOS (Swift + AVFoundation), Linux (arecord/parecord/pw-record) — and sent to a configurable speech-to-text provider. Transcribed text is appended to the chat input. Auto-stops after 2 minutes. Cleanup on component unmount
- **Voice Settings**: New "Voice Input" section in the settings panel with provider selection (OpenAI Whisper, Deepgram, Google Cloud STT), API key management via SecretStorage (OS keychain), and configurable language via a Select dropdown with 19 language options. API key status shown with green/red indicator. VS Code settings `damocles.voice.provider` and `damocles.voice.language` persist provider and language preferences

### Known Limitations

- **Remote SSH**: Voice recording requires local audio hardware. When VS Code is connected to a remote host via SSH, the extension host runs on the remote server — native audio capture processes (PowerShell, Swift, arecord) spawn on the headless remote machine where no microphone is available, causing recording to fail

## [1.1.24] - 2026-02-15

### Fixed

- **Distill Session Scroll-Up Pagination**: `sessionStarted` handler now restores `currentResumedSessionId` so the intersection observer guard allows fetching older history
- **History Replay Rendering Fidelity**: Replayed assistant messages now carry `contentBlocks` and consecutive JSONL entries with the same SDK message ID are merged, matching the live streaming data shape for interleaved rendering
- **Prompt Index Numbering on Paginated History**: `getPromptIndexForMessage()` now accounts for user prompts in earlier pages via `promptIndexOffset`, so prompt badges show correct numbers after scroll-up pagination
- **Haiku Annotation Timeout**: Removed the 120-second hard timeout that caused annotation aborts on larger sessions — existing abort mechanisms (user cancel, annotation superseding) are sufficient
- **Context Injection Overlay Scroll**: Fixed flex layout so the overlay scrolls correctly when content exceeds viewport height

### Changed

- **Distill Persistence Write Ordering**: Assistant content now persists before its tool results in the queue, matching the SDK's wire order

## [1.1.23] - 2026-02-15

### Added

- **Query Decomposition for Multi-Topic Retrieval**: Haiku decomposes the user's prompt into 1-4 keyword-rich search facets before BM25 retrieval (`damocles.distillQueryDecomposition`, enabled by default). Each facet runs as a separate FTS5 query, results are deduplicated (keeping the best BM25 rank per entry), and merged — ensuring balanced topic coverage for multi-topic prompts like "fix the permission handler and update the annotation pipeline" that single-pass BM25 would bias toward one topic. Falls back to single-pass on timeout or error. Orthogonal to reranking — both can be enabled simultaneously. Decomposition facets are persisted in the `context_injections` table (Schema V5) and displayed in the Context Injection Overlay as a "Decomposition" badge and facets tag list
- **Database Schema V5 Migration**: Adds `decomposition_facets` column (TEXT, JSON array) to the `context_injections` table. Non-destructive — existing V4 databases upgrade automatically on open

### Changed

- **Unified Retrieval Pipeline**: Replaced the two separate retrieval functions (`retrieveContextForPrompt` and `retrieveContextWithReranking`) with a single `retrieveContext()` that accepts a `RetrievalOptions` object. The old functions duplicated ~80% of their logic (continuity layer, budget tracking, semantic group expansion). The unified function handles all combinations of {no facets, facets} × {no reranking, reranking} through a single code path. New internal `runMultiPassRetrieval()` runs per-facet BM25 queries with generous per-facet limits, deduplicates by entry ID, and caps at the original limit
- **Reranking Auto-Skip Below Entry Threshold**: When reranking is enabled, the facade now checks the annotated entry count before spawning the Haiku reranking subprocess. If the count is below `RERANKING_MIN_ENTRIES` (25), reranking is skipped and BM25 results are used directly. Empirical analysis showed zero semantic improvement from reranking at small index sizes (< 25 entries), with the breakeven at ~25-30 entries where BM25 noise begins to emerge. This avoids a wasted SDK subprocess cold-start (2-4s latency) on early prompts when BM25 alone returns near-optimal results. New `getAnnotatedEntryCount()` in `context-database.ts` provides a lightweight COUNT query for the check

## [1.1.22] - 2026-02-14

### Added

- **Context Injection Viewer**: Per-prompt overlay showing what context was injected during distill mode. An always-visible pill inside each user message (pulsing indicator + database icon + label) opens a full-screen `OverlayShell` with structured entry cards (file paths, prompt indices, semantic group badges, descriptions) and header badges for entry count, token budget, and reranking status. When Haiku reranking is enabled, renders side-by-side BM25 vs reranked columns
- **Context Injection Persistence (Schema V4)**: New `context_injections` table stores BM25 and reranked context per prompt with metadata, so the viewer works for both live and historical sessions

### Changed

- **Dual-Path Context Retrieval**: `getContextForInjection()` now always runs BM25 first, then optionally runs Haiku reranking, storing both results via `insertContextInjection()`. Previously these were mutually exclusive branches
- **User Message Bubble Styling**: Replaced `border-l-2 bg-muted` with `rounded-xl bg-muted/75 ring-1 ring-border/60` for modern appearance. Injected/queued messages use amber ring variant. Tightened vertical padding from `py-3` to `py-1.5`

## [1.1.21] - 2026-02-14

### Added

- **Discussion Entry Type for Text-Only Responses**: Added `discussion` to the `EntryType` union to capture pure text responses that previously yielded zero database entries. When `EntryCoordinator.finalize()` detects that `EntryTracker` returned zero entries but the assistant text buffer contains content, it inserts a `discussion` entry (`file_path=null`) so the response gets annotated by Haiku and becomes searchable via FTS5. The annotation system prompt (`STRUCTURED_ANNOTATION_SYSTEM_PROMPT`) now documents discussion entries and instructs Haiku to use the `assistant_activity` section for their description and tags. Without this, informational answers, explanations, and planning responses were invisible to context retrieval.

### Changed

- **Context Distillation Module Decomposed into Facade + Managers**: Refactored the 952-line `context-distillation/index.ts` monolith into a thin facade (~330 lines) that wires four single-responsibility managers via dependency injection — the same pattern used by `streaming-manager/` and `permission-handler/`. The facade retains session ID management, database lifecycle, config, and cross-manager event routing. Each manager receives its dependencies through getter closures (`getDb()`, `getPersistenceSessionId()`) so session state changes propagate automatically without re-wiring. New files:
  - `managers/haiku-annotation-manager.ts` (~320 lines): Annotation pipeline, wait gate, abort handling, Haiku log writing. Owns `_haikuProcessing`, completion resolvers, and the full `runAnnotation()` streaming loop.
  - `managers/subagent-manager.ts` (~170 lines): Subagent file initialization, write queue management, thinking/tool-result routing with boolean return values for subagent-vs-main dispatch, and final response assembly.
  - `managers/ui-display-manager.ts` (~140 lines): Activity timeline (`getHaikuActivities()`), JSONL log parsing (`parseHaikuLogBlocks()`), and context summary generation. Stateless — depends only on DB and session ID.
  - `managers/entry-coordinator.ts` (~90 lines): Entry tracking lifecycle (`EntryTracker` creation/finalization), assistant text accumulation, prompt index management, and `finalize()` snapshot for annotation handoff.
  - `utils.ts` (~130 lines): Pure stateless helpers extracted from the class — `loadSdkQuery()` (module-level cached), `buildAgentAssistantEntry()`, `buildAgentToolResultEntry()`, `parseSubagentFinalContent()`, `buildAnnotationDisplayData()`.
  - `types.ts`: Added `SubagentPersistState` interface and `SdkQuery` type alias (moved from `index.ts`).
- **No Consumer Changes Required**: The `ContextDistillationService` public API is identical — all existing imports from `context-distillation` and `context-distillation/types` continue to work without modification.

## [1.1.20] - 2026-02-14

### Added

- **Entry Annotation Lifecycle**: Context entries now transition through a formal state machine (`pending` → `annotating` → `annotated`/`failed`/`skipped`) tracked via a new `annotation_status` column. Previously, entries went from "inserted" to "maybe annotated" with no way to distinguish between "never attempted" and "attempted but failed". New `setAnnotationStatus()` batch-updates entry states, `getFailedEntries()` retrieves entries that failed annotation in prior prompts. Entry states are visible throughout the pipeline: FTS5 retrieval now filters on `annotation_status = 'annotated'` (excluding pending/failed entries from search results), and the Haiku Observer overlay reports `failedCount` in annotation results.
- **Incremental Annotation with Failed Entry Retry**: Annotation is no longer all-or-nothing. If Haiku times out or the structured output retry limit is reached, whatever annotations were successfully produced are applied — the condition changed from `structuredOutput && !isRetryError` to just `structuredOutput`. Entries that were not annotated (either from the current prompt or retries) are marked `failed` and automatically retried on the next prompt. Failed entries are formatted as `<retry_entries>` in the Haiku annotation prompt (up to `MAX_FAILED_RETRY_ENTRIES = 10` per prompt), using the same XML shape as current entries so Haiku treats them uniformly. The system prompt instructs Haiku to annotate retry entries using their original context.
- **Semantic Group Retrieval**: The `semantic_group` field (added in V2 but previously display-only) is now used for associative retrieval. When a BM25 hit has a semantic group label (e.g., `"auth-refactor"`), the retriever pulls up to 3 additional annotated entries from the same group via `getGroupEntries()`, surfacing related entries that keyword search alone would miss. Group expansion runs in both the standard FTS retrieval path and the Haiku re-ranking path, respecting the token budget. A new `semantic_groups` table tracks aggregate metadata per group (first/last prompt, entry count) via `upsertSemanticGroup()`.
- **Database Schema V3 Migration**: `context_entries` gains `annotation_status` (TEXT, default `'pending'`) with index. New `semantic_groups` table with `UNIQUE(session_id, label)` constraint. Backfill sets existing annotated entries to `'annotated'` and low-relevance-without-description entries to `'skipped'`. Migration is non-destructive — existing V2 databases upgrade automatically on open.

### Changed

- **`applyAnnotations()` Returns Annotated IDs**: Return type changed from `void` to `number[]`. Collects and returns the IDs of entries that received annotations, enabling the caller to determine which entries were successfully annotated vs. which need to be marked `failed`. Accepts an optional `additionalValidIds` parameter for retry entries from prior prompts that aren't in the current prompt's entry set.
- **`getRecentAnnotatedEntries()` Uses Lifecycle Status**: WHERE clause tightened from `description IS NOT NULL` to `annotation_status = 'annotated'` (semantically identical after V3 backfill, but more explicit and aligned with the lifecycle model).
- **FTS5 Retrieval Filters by Annotation Status**: `runFtsRetrieval()` now includes `AND ce.annotation_status = 'annotated'` in the WHERE clause, ensuring pending and failed entries (which lack meaningful descriptions and tags) are excluded from search results.

## [1.1.19] - 2026-02-13

### Fixed

- **Panel Focus-Stealing When Damocles Open in Side Column**: Fixed Ctrl+C and other editor keyboard shortcuts intermittently failing when a Damocles panel was open alongside the editor. The `createPanelHost` adapter mapped `panel.onDidChangeViewState` (fires on any active/inactive/visible state change) directly as `onDidChangeVisibility`, violating the event's contract. When the user clicked the editor, the panel went `active=false` (but stayed `visible=true`), triggering a spurious visibility event → `panelFocused` message → webview `focus()` call → focus jumped back to the webview. Added a `prevVisible` state guard in the event listener closure so the adapter only fires when `panel.visible` actually transitions, matching the behavior of the `createViewHost` adapter which passes through `view.onDidChangeVisibility` directly.

### Changed

- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.39` to `^0.2.41`.

## [1.1.18] - 2026-02-13

### Added

- **Opus 4.5 Model Option**: Added `claude-opus-4-5-20251101` (Opus 4.5) back as a selectable model in the settings panel, positioned after Opus 4.6 and before Sonnet 4.5.

### Changed

- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.38` to `^0.2.39`.

### Removed

- **Redundant `damocles.contextStrategy` VS Code Setting**: Removed the `damocles.contextStrategy` configuration schema from `package.json`. The SettingsPanel already provides "This panel" and "Default for new panels" dropdowns for context strategy, which update the in-memory cache and broadcast to all panels immediately. The native VS Code setting was redundant — it read/wrote the same underlying config value but was only consulted at startup, while the SettingsPanel interface provides real-time updates. Programmatic reads/writes in `ContextStrategyManager` continue to work since VS Code's configuration API does not require schema registration.

## [1.1.17] - 2026-02-10

### Added

- **Structured Annotation Pipeline**: Replaced the multi-round MCP tool-calling annotation flow (4 MCP tools, 10+ round-trips per prompt) with a single SDK `outputFormat: { type: 'json_schema' }` call that produces validated JSON in one pass. Haiku now receives current entries and up to 30 historical annotated entries, and outputs a structured `AnnotationResult` containing per-entry annotations (description, tags, related files, confidence, semantic group), cross-prompt entry links (depends_on, extends, reverts, related), and a prompt summary — all in a single turn with automatic retry on malformed JSON. Deleted `context-mcp-server.ts` (92 lines). New exports: `ANNOTATION_OUTPUT_SCHEMA`, `RERANKING_SCHEMA`, `buildAnnotationPrompt()`.
- **Cross-Prompt Entry Links**: New `entry_links` table connects entries across prompts with typed relationships (depends_on, extends, reverts, related). Links are created by Haiku during annotation based on semantic analysis of current vs. historical entries. During retrieval, entries connected via links to the BM25-selected set are expanded into the context window (up to 10 linked entries), surfacing relevant prior work that keyword search alone would miss.
- **Semantic Re-ranking (opt-in)**: Optional second-pass re-ranking of BM25 retrieval results using Haiku. When `damocles.distillReranking` is enabled, the retriever widens BM25 to 100 results, takes the top 40 candidates, sends them to Haiku for relevance scoring (0-10) via structured JSON output, then selects entries by score instead of BM25 rank. Falls back to BM25 order on timeout (`damocles.distillRerankingTimeout`, default 3000ms) or error. Link expansion runs after re-ranking selection.
- **Database Schema V2 Migration**: `context_entries` gains `confidence` (REAL) and `semantic_group` (TEXT) columns. FTS5 virtual table rebuilt to include `semantic_group` in the full-text index. New `entry_links` table with composite unique constraint and indexed foreign keys. Migration is non-destructive — existing databases upgrade automatically on open.
- **Annotation Summary Card**: The Haiku Observer overlay now shows a compact annotation summary card instead of individual MCP tool call cards. Displays count of annotated entries, low-relevance entries, cross-prompt links, prompt summary text, and semantic group badges.
- **VS Code Settings**: `damocles.distillReranking` (boolean, default false) and `damocles.distillRerankingTimeout` (number, default 3000, range 1000-10000).

### Changed

- **Async Context Injection**: `getContextForInjection()` is now async to support the optional re-ranking pass (which makes an SDK query). The async signature propagates through `HookDependencies.getDistilledContext` → `QueryManager` lambda → `hook-handlers.ts` `UserPromptSubmit`. When re-ranking is disabled, the synchronous BM25 path is called directly (no await overhead).
- **Context Retriever Refactored**: Extracted `getContinuitySection()`, `runFtsRetrieval()`, and `buildOutputSections()` helpers from `retrieveContextForPrompt()`. New `retrieveContextWithReranking()` and `rerankWithHaiku()` functions. `formatEntry()` now includes the semantic group label when present.
- **Haiku Stream Events Simplified**: `haikuStreamDelta.deltaType` reduced from `'thinking' | 'text' | 'tool_start' | 'tool_input' | 'tool_result'` to `'thinking' | 'text'` — MCP tool streaming is no longer needed since annotation happens in a single structured output call.

### Removed

- **Context MCP Server**: Deleted `context-mcp-server.ts` — the 4 MCP tools (`list_prompt_entries`, `update_entry_description`, `mark_low_relevance`, `write_prompt_summary`) are replaced by the structured annotation schema. Removes `createSdkMcpServer`, `tool`, and `zod` dependencies from the distillation module.
- **Tool Card UI in Haiku Observer**: Removed tool call card rendering, `expandedToolCall` computed, `expandBlock`/`collapseBlock` methods, `McpToolOverlay` stacking for haiku, `formatInput`/`truncateResult` helpers, `LoadingSpinner`/`IconMcp` imports from the overlay.

### Fixed

- **YOLO Mode Auto-Approving Interactive Tools in Plan Mode**: Fixed `AskUserQuestion` and `ExitPlanMode` being silently auto-approved when YOLO mode (`dangerouslySkipPermissions`) was enabled alongside plan mode. The `canUseTool()` evaluator's YOLO gate returned `'allow'` for all tools, and the early-return on `evaluation === 'allow'` fired before the code reached the interactive tool handlers — so the user never saw the plan approval UI or question prompts. Reordered `canUseTool()` to route `ExitPlanMode` (in plan mode) and `AskUserQuestion` to their handlers before consulting the evaluator, since these are interactive tools that require user input to produce a meaningful result, not permission-gated operations.

## [1.1.16] - 2026-02-10

### Removed

- **Distill `result_summary` Field**: Removed `result_summary` from `ToolCallRecord` and the entire result-tracking pipeline (`onToolResult()`, `unwrapResultJson()`, `findCallForResult()`) from `EntryTracker`. The field stored full unbounded tool output (entire file contents for Read, full command output for Bash) but was never consumed downstream — `context-retriever.ts` reads only `tool_name` + `input_summary`, FTS5 indexes only `file_path`/`description`/`tags`, and Haiku already receives equivalent information via `<assistant_activity>` (300-char result previews + Claude's full reasoning text from `assistantTextBuffer`). The field's only consumer was `list_prompt_entries`, where it caused a 285K-character overflow that broke Haiku's annotation workflow. Old databases with `result_summary` in stored JSON are handled gracefully — the MCP server explicitly projects only `tool_name` + `input_summary` from the `tool_calls` column.

## [1.1.15] - 2026-02-10

### Fixed

- **Distill Session Registry Desync**: Replaced the JSON file-based distill session registry (`distill-sessions.json`) with a filesystem-based directory scan. The JSON registry was systematically out of sync — 85 out of 103 distill databases were unregistered, causing distill sessions to appear as "normal" in session history without the distill badge. The new registry scans `~/.damocles/context/distill/` for `.db` files at startup with `existsSync` fallback for cache misses, and deduplicates concurrent `loadRegistry()` calls via a shared promise. The `.db` file created by `ContextDistillationService` constructor is now the sole source of truth — no separate registration file to fall out of sync.
- **WebFetch Overlay Showing Raw JSON**: Fixed WebFetch tool results displaying the full JSON response object (`{ bytes, code, result }`) instead of the rendered `result` content in tool overlays. Added `normalizeWebFetchResult()` that extracts the `result` field from both live SDK responses (structured object via `PostToolUse`) and historical sessions (JSON string from JSONL where `toolUseResult` is null).

### Changed

- **Distill `input_summary` MCP Value Extraction**: The default case in `summarizeToolInput()` now extracts string and number values from inputs instead of storing key names. `mcp__context7__resolve({ libraryName: 'typescript' })` now produces `"typescript"` instead of `"libraryName"`, giving Haiku and FTS5 meaningful content to work with.
- **Distill Registry Diagnostic Warning**: `StorageManager.upsertSessionInCache()` now logs a warning when an `isDistill=true` session is about to be overwritten with `isDistill=false`, aiding future debugging of registry/metadata mismatches.

## [1.1.14] - 2026-02-10

### Fixed

- **Subagent Tool Calls Leaking into Distill Context Database**: Fixed subagent internal tool calls (Write, Read, Grep, etc.) being tracked in the FTS5-indexed context database when using distill mode with subagents (Task tool). Three leak paths plugged: `assistant-processor.ts` now guards `onToolUse` dispatch with `!parentToolUseId`, `stream-event-processor.ts` guards `onStreamDelta` dispatch similarly, and `index.ts` reorders `onToolResult` to check subagent routing before entry tracker and text buffer writes. Previously, a subagent writing a file would create a `file_change` entry in the context database, polluting Haiku annotations and FTS5 retrieval for future prompts.

### Changed

- **Task Tool Entry Tracking**: Task tool `input_summary` now stores the full subagent prompt (`input.prompt`) instead of the short description (`input.description`), providing meaningful context for Haiku annotation and FTS5 retrieval.
- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.37` to `^0.2.38`.

## [1.1.13] - 2026-02-10

### Added

- **Configurable Distill Token Budget**: The distill context retrieval token budget is now configurable via `damocles.distillTokenBudget` (500–16000, default 4000). Controls how much past context is injected per query in distill mode. Exposed in the settings panel as a number input that appears conditionally when distill mode is active. Changes take effect on the next query without clearing the session.

### Changed

- **ContextDistillationService Dependency Injection Refactor**: `ContextDistillationService` no longer constructs its own `DistillationConfig` from a raw strategy string. Config construction moved to `ContextStrategyManager.buildDistillConfig(panelId)`, which combines the per-panel strategy with settings-layer values (`observerModel`, `tokenBudget`). The service receives a complete `DistillationConfig` via constructor and `refreshConfig()`. `ClaudeSession.refreshContextStrategy(strategy)` renamed to `refreshDistillConfig(config)`. `SessionManagerConfig.getActiveStrategyForPanel` removed from the session manager — `buildDistillConfig` subsumes it for service creation.
- **Haiku Observation Timeout**: Increased from 30s to 2 minutes (120s). Complex turns with many entries could get cut short, leaving entries without annotations and no prompt summary (breaking continuity for the next turn).
- **Consolidated `DEFAULT_TOKEN_BUDGET` / `DEFAULT_OBSERVER_MODEL`**: Moved from duplicate definitions in `context-distillation/index.ts` and `context-retriever.ts` to a single source of truth in `context-distillation/types.ts`, re-exported from the module barrel.

### Fixed

- **Store `$reset()` missing `distillTokenBudget`**: `useSettingsStore.$reset()` now resets `distillTokenBudget` to its default (4000). Previously the value remained stale from the previous session after a reset.
- **Server-side validation for `setDistillTokenBudget`**: The extension handler now clamps incoming values to the valid range (500–16000) with `NaN` guard, preventing malformed `postMessage` calls from setting arbitrary values.
- **Silent invalid token budget input**: `SettingsPanel` now clamps out-of-range values to the nearest valid bound instead of silently dropping them.

## [1.1.12] - 2026-02-09

### Added

- **Database-Backed Context Distillation**: Replaced the in-memory `context.md` living document with per-session SQLite FTS5 databases. Each distill session gets its own database (`~/.damocles/context/{sessionId}.db`) with structured entries tracked by file path, entry type, tool calls, tags, and related files. Haiku no longer rewrites a monolithic markdown document — it annotates individual entries via 4 MCP tools (`list_prompt_entries`, `update_entry_description`, `write_prompt_summary`, `get_context_summary`). Context retrieval uses FTS5 full-text search ranked by BM25, with a two-layer output: continuity (previous prompt's summary, always included) and relevant context (FTS-matched entries, budget-constrained). New modules: `context-database.ts` (schema + CRUD + FTS5 triggers), `entry-tracker.ts` (tool call grouping by file path), `context-mcp-server.ts` (4 MCP tools for Haiku annotation), `context-retriever.ts` (FTS5 retrieval with token budget). The user's prompt is now passed through to `getContextForInjection()` → `retrieveContextForPrompt()` for FTS5 query building.
- **Clickable Haiku Observer Tool Cards**: Tool call cards in the Haiku Observer overlay are now clickable, opening the `McpToolOverlay` with full syntax-highlighted JSON input and response. New `McpToolData` interface declares only the 5 fields the overlay consumes (`name`, `input`, `status`, `result`, `errorMessage`). `ToolCall` satisfies this via structural typing — existing main chat callers are unchanged. The tool detail overlay stacks on top of the Haiku Observer via DOM order; ESC closes the detail first, returning to the observer.
- **Context Distillation Test Suite**: Comprehensive standalone test file (`scripts/test-distill.js`) with 226 assertions covering all context distillation functionality: FTS5 query building, entry classification, database CRUD, full-text search, multi-prompt retrieval, token budget enforcement, related files, deduplication, MCP tools, Haiku prompt building, entry grouping, session isolation, and edge cases.

### Changed

- **Context Distillation Architecture**: Replaced `context-store.ts` (in-memory document holder), `haiku-observer.ts` (background Haiku call with state machine), and `haiku-activity-store.ts` (per-prompt disk persistence) with the database-backed modules. The `index.ts` facade now manages per-session database lifecycle, tool call tracking via `EntryTracker`, streaming block extraction from Haiku's JSONL conversation, and FTS5 context retrieval via the user's prompt. Haiku's system prompt (`prompts.ts`) is rewritten for MCP tool usage with structured annotation instructions instead of full-document rewriting. `openContextFile` now renders a virtual document from `getContextSummary()` (database query) instead of reading a `context.md` file from disk. `openHaikuLog` delegates path resolution to `getHaikuLogPath()` on the service.

### Fixed

- **McpToolOverlay "No Response Available" for Haiku Tool Results**: Fixed the overlay showing "No response available" when viewing Haiku observer tool results. The `parsedResult` computed assumed all JSON arrays were Claude API content block arrays (`[{type: "text", text: "..."}]`), but Haiku tool results are pre-extracted plain text (e.g., a JSON array of entry objects with `entry_type` instead of `type`). Added format detection: arrays are only treated as content blocks when the first element has `type === 'text'`. Non-matching arrays pass through as raw JSON and render with syntax highlighting via the existing `responseIsJson` / `CodeBlock` path.

## [1.1.11] - 2026-02-09

### Fixed

- **Subagent Message Sealing**: Fixed race condition where duplicate assistant messages could appear in the subagent overlay. Two uncoordinated paths — the live streaming flush (`addMessageToSubagent`) and the JSONL replacement (`replaceSubagentMessages`) — could emit the same message. Added a `messagesSealed` state-gate on `SubagentState`: once `replaceSubagentMessages` fires with canonical JSONL data, the subagent's messages are sealed and late streaming appends (`addMessageToSubagent`, `updateSubagentStreaming`, `addToolCallToSubagent`) become no-ops. Status and metadata updates on existing tool calls are intentionally not guarded, as they modify data already present in the sealed messages. The existing early flush in `hook-handlers.ts` is preserved as defense-in-depth.

## [1.1.10] - 2026-02-09

### Changed

- **OverlayShell Migration**: Migrated all 5 remaining overlay components (`DiffOverlay`, `HaikuObserverOverlay`, `PlanApprovalOverlay`, `PlanViewOverlay`, `SubagentOverlay`) to use the shared `OverlayShell.vue` frame component. Each overlay previously duplicated ~15 lines of identical container, header, escape-key, and close-button boilerplate. `OverlayShell` gained three new capabilities: `titleClass` prop (used by `DiffOverlay` for `font-mono` file paths), `#subtitle` named slot with prop fallback (used by `DiffOverlay` for colored +N/-N diff stats), and `#footer` named slot (used by `PlanApprovalOverlay` for its action bar). Content padding moved from `OverlayShell` into each consumer, giving overlays individual control — `ToolOverlay`/`McpToolOverlay`/`SubagentOverlay` use `p-4 space-y-4`, `PlanViewOverlay`/`PlanApprovalOverlay`/`HaikuObserverOverlay` use `p-4`, and `DiffOverlay` uses none for edge-to-edge rendering.

## [1.1.9] - 2026-02-09

### Added

- **Built-in Tool Overlays**: Bash, Read, Grep, Glob, WebFetch, and WebSearch tool cards are now clickable, opening a full-screen overlay with per-tool input rendering and syntax-highlighted or markdown-rendered responses. Extracted reusable `OverlayShell.vue` frame component shared with the existing MCP tool overlay. Generalized MCP-specific store identifiers (`expandedMcpToolId` → `expandedToolId`, `expandMcpTool` → `expandTool`) so the same expansion mechanism handles both built-in and MCP tools. New `ToolOverlay.vue` routes WebFetch/WebSearch responses through `MarkdownRenderer` and all others through `CodeBlock` with file-extension-based language detection for Read results.

### Changed

- **Removed Response Truncation from Overlays**: Both `ToolOverlay` and `McpToolOverlay` now show complete tool results with native scrolling instead of truncating at 2000 chars with a "Show full response" toggle. Full-screen overlays are explicitly opened to see everything — the inline `ToolCallCard` already truncates to 200 chars for the summary view.
- **Read Tool Overlay Metadata Info Card**: Read tool overlays now display a file metadata card between the input and response sections showing line range (e.g., "Lines 27–33"), total file lines, and a progress bar with percentage for partial reads. Metadata is extracted from the SDK's structured response (`file.numLines`, `file.startLine`, `file.totalLines`) and flows via `toolMetadata` messages (live) or `tool.metadata` (history). Clicking the file path now opens the file at `startLine` instead of always line 1.

### Fixed

- **Read Tool Overlay Showing Broken Content**: Fixed Read tool results displaying raw JSON (live mode) or cat-n prefixed text with `<system-reminder>` contamination (history mode). The SDK's `PostToolUse` hook returns a structured object (`{ type: "text", file: { filePath, content, numLines, startLine, totalLines } }`) which was being JSON-stringified verbatim. Historical sessions store the SDK's `cat -n` formatted string (`     1→<script...`) with system-reminder tags appended. Added `normalizeReadResult()` that extracts clean file content from structured objects and strips line number prefixes + system-reminder tags from historical text, enabling proper syntax highlighting in the overlay's `CodeBlock`.
- **Read-Only Tools Blocked in Plan Mode**: Fixed Read, Glob, Grep, WebFetch, WebSearch, and LSP triggering a native VS Code `showInformationMessage` popup in plan mode instead of being silently auto-approved. The v1.1.8 evaluator restructure gated read-only auto-approval behind `mode !== 'plan'`, but Claude can't plan without reading the codebase. Read-only tools are now auto-approved unconditionally in all modes — permission modes only differ in how they handle write tools (Edit, Write, Bash).
- **WebSearch Overlay Showing Raw JSON**: Fixed WebSearch tool results displaying raw `Links: [{"title":"...","url":"..."},...]` JSON in the overlay. The SDK's `PostToolUse` hook returns a structured object (`{ query, results: [{ content: links[] }, markdownSummary], durationSeconds }`) which was being JSON-stringified verbatim. Added `normalizeToolResult()` that extracts links as markdown bullet points and preserves the rich summary content, stripping the model-facing `REMINDER:` instruction. Handles both the structured object format (live `PostToolUse` calls) and the `Links: [...]` text format (historical sessions loaded from JSONL via `history-manager.ts`).
- **ToolOverlay Falsy-Value Bugs**: Fixed `v-if="tool.input.offset"` hiding the offset/limit row when the value is `0` (a valid Read offset). Same fix for Grep context flags (`-A`, `-B`, `-C`). Changed to `!= null` checks and `??` instead of `||` for value display.
- **ToolOverlay Hardcoded English Labels**: Status badge labels ("Running", "Completed", "Failed") now use `t()` i18n function instead of hardcoded English strings.

## [1.1.8] - 2026-02-09

### Fixed

- **Permission Mode Hierarchy Not Structurally Enforced**: Fixed `acceptEdits` mode being paradoxically more restrictive than `default` mode — read-only tools (Read, Glob, Grep, WebFetch, WebSearch, LSP) were not auto-approved in `acceptEdits` because each mode was implemented as an independent branch with its own complete approval list. Restructured the evaluator as cumulative layers where each mode inherits all auto-approvals from less-permissive modes: `plan` (most restrictive) → `default` (adds read-only tools) → `acceptEdits` (adds Edit/Write). Previously, using Read in `acceptEdits` mode fell through to a native VS Code `showInformationMessage` popup instead of being silently approved.
- **Printf-Style Format Specifiers in Extension Logs**: Fixed `%s` and `%d` placeholders printing literally in extension output (e.g., `controller=%s false` instead of `controller=false`). The `log()` function joined args with spaces without resolving format specifiers. Replaced with `util.format()` from Node.js, which handles both printf-style (`log('x=%s', val)`) and plain concatenation (`log('hello', 'world')`) correctly. Affects 63 log calls across 16 files.

## [1.1.7] - 2026-02-08

### Added

- **Subagent JSONL Persistence in Distill Mode**: Subagent tool call details are now persisted to per-agent JSONL files in distill mode. `persistSession: false` previously disabled all SDK persistence including subagent files, leaving the subagent overlay empty. `ContextDistillationService` now routes messages by `parentToolUseId` — subagent data goes to `agent-{id}.jsonl` files, main session data goes to `DistillPersistence`. Subagent correlation entries use `persistenceSessionId`. Output format matches SDK-generated files so all existing readers work without modification.
- **Content Block Deduplication in Agent JSONL Reader**: `readAgentData()` deduplicates `tool_use` (by ID), `thinking` (one per message), and `text` (by equality) blocks. Client-side writes produce partial then full entries, which previously caused duplicates in the subagent overlay.

### Fixed

- **Distill Session Delete Not Detecting Active Session**: Fixed `deleteSession` handler using `currentSessionId` (rotating SDK ID) instead of `persistenceSessionId` (stable UUID) to detect the active session. In distill mode these never match, so deleting the active session left it running with stale webview state.
- **Subagent Persistence Memory Leak**: Fixed `_activeSubagents` entries never being cleaned up after writes completed. Entries are now deleted after `onSubagentDataReady` fires.
- **Swallowed Subagent Init Error**: Fixed `initSubagentFile` failures being silently resolved, causing cascading ENOENT errors on all subsequent writes. An `initFailed` flag now skips downstream writes while still notifying the webview.
- **Tool Result Ordering in Distill Persistence**: Fixed `persistAssistantQueued()` writing assistant text before tool results. Tool results are now persisted first, matching chronological order.
- **Stale Distill Mode Gate in ToolManager**: Replaced construction-time `contextDistillation?.isEnabled` check with a dynamic `isDistillModeActive()` callback. The old check was always truthy (service object exists regardless of mode), suppressing normal-mode subagent data updates.

## [1.1.6] - 2026-02-08

### Fixed

- **Plan Workflow in Distill Mode**: Fixed plan file creation, discovery, and binding silently failing in distill mode. The SDK's slug-based plan binding relies on writing entries to JSONL (`persistSession: true`), which distill mode disables. Plan file paths are now captured as first-class session metadata (`plan-path` entries in the JSONL) — detected from Write tool calls targeting `~/.claude/plans/*.md` and persisted client-side by `DistillPersistence`. A unified `resolvePlanFilePath()` utility checks `planPath` first, falling back to slug-based resolution for normal sessions. "Open Plan" and "Bind Plan" now use `persistenceSessionId` (the stable UUID) instead of `currentSessionId` (which rotates per query in distill mode). Slug-based binding in the PostToolUse and Stop hooks is skipped when distill is enabled.
- **Clear Context Not Resetting Distill State**: Fixed "Clear context & auto-accept" in plan approval not resetting the `ContextDistillationService`. Stale distilled context from the planning session bled into the implementation session. The handler now calls `clear()` (which resets distill context, context store, and Haiku observer) instead of `reset()`. Plan path is captured before clearing and carried to the new session, where it's written to the new JSONL during `persistence.initialize()`.
- **`ClaudeSession.clear()` Incomplete Reset**: Enhanced `clear()` to use `queryManager.reset()` (clears cached model info) and `checkpointManager.reset()` (full checkpoint cleanup) instead of the shallower `closeAndReset()` and `setResumeSession(null)`. Makes `clear()` the definitive session-clearing method.

### Changed

- **Plan File Reference in Distilled Context**: When a distill session has an associated plan file, a reference to the plan file path is appended to the injected context document, directing Claude to read the plan before starting implementation.

## [1.1.5] - 2026-02-08

### Changed

- **HaikuObserver Single-Call Model**: Replaced the iteration loop state machine (`idle`→`running`→`waiting`→`done`) with a single Haiku call fired after streaming ends (`idle`→`running`→`done`). The observer now accumulates content passively during the main response and fires one Haiku call in `finalize()`. Intermediate mid-stream calls were always discarded — only the final iteration updated context — so this removes wasted work and eliminates race conditions between iteration scheduling and finalization. Removed `onContentBlockCommitted()` from `HaikuObserver`, `ContextDistillationService`, and the `stream-event-processor` content block stop handler. `startObservation()` no longer emits `onProcessingChange(true)` prematurely — processing now starts when the single Haiku call fires.
- **Haiku Finalization on Cancel**: `ClaudeSession.cancel()` now calls `onResponseComplete()` after `cancelPendingWait()`, triggering Haiku finalization for the accumulated buffer when the user cancels mid-stream. The idempotent guard in `finalize()` (`observerState !== 'idle'`) prevents double-fire from the result-processor and cancel race.
- **Iteration → Observation Vocabulary**: Renamed all iteration-era naming to observation across the entire Haiku observer stack (9 files). Callbacks renamed `onIterationStart/Complete` → `onObservationStart/Complete` with the now-vestigial `iteration` number parameter and always-true `isFinal` parameter removed. Message types renamed `haikuIterationStart/Complete` → `haikuObservationStart/Complete`. Log events renamed `iteration_start/complete` → `observation_start/complete`. Removed the `HaikuIteration` type and `iterations` array from `HaikuPromptActivity` — these existed solely for multi-iteration history display which can't occur in the single-call model. Removed 6 refs/computeds from `useHaikuObserverStore` (`streamingIteration`, `streamingIterations`, `lastCompletedThinking/Text`, `currentIterationHistory`, `totalIterations`) and the "earlier iterations" collapsible section from `HaikuObserverOverlay.vue`. Cleaned up 3 dead i18n keys.

### Fixed

- **Distill Session Cleanup on Delete**: Deleting a distill session from history now removes the Haiku activity directory (`~/.damocles/context/haiku/{sessionId}/`) containing per-prompt `haiku.jsonl` logs and `context.md` snapshots. Previously only the distill registry entry was cleaned up, leaving orphaned observation files on disk. Also removed the stale cleanup of `{sessionId}.context.md` (dead since ContextStore was refactored to in-memory only in v1.1.4).
- **Distill Session Conflict on First Message**: Fixed "Session ID already in use" error on the first message in distill mode after extension activation. The constructor, `setSessionId()`, and `reset()` all set `_sessionId` to the same value as `_persistenceSessionId`, so the SDK rejected the session ID that was already associated with the JSONL persistence layer. Each now generates a separate `crypto.randomUUID()`, matching the pattern already used by `regenerateSessionId()` (the conflict recovery path). Eliminates the ~2s retry overhead on every first message.

## [1.1.4] - 2026-02-07

### Added

- **Haiku Observer Overlay**: New full-screen overlay (sparkles icon in chat header) showing all Haiku iterations per prompt, replacing the read-only `ContextViewOverlay`. Each prompt's observation history is navigable with prev/next buttons. The final iteration is shown by default with a collapsible "earlier iterations" section for intermediate passes. Live streaming displays thinking and text deltas in real-time. Quick-action buttons open the raw `haiku.jsonl` log or the `context.md` snapshot in VS Code editor. New `HaikuObserverOverlay.vue` component with `useHaikuObserverStore` Pinia store managing overlay state, prompt navigation, streaming buffers, and iteration history.
- **Per-Prompt Activity Tracking**: New `HaikuActivityStore` persists Haiku observations in per-prompt directories (`~/.damocles/context/haiku/{sessionId}/prompt-N/`) containing `haiku.jsonl` (iteration lifecycle events) and `context.md` (finalized context snapshot). Each prompt's iterations — including intermediate passes where the buffer grew during observation — are recorded and recoverable. Session resume restores both the latest context snapshot and prompt index from disk.
- **Tool-Aware Haiku Observations**: The Haiku observer now tracks tool usage during the main response. `appendToolUse()` injects `[Tool: name] summary` markers and `appendToolResult()` injects truncated results into the observation buffer. Tool summaries are format-aware: file paths for Read/Write/Edit, commands for Bash, patterns for Glob/Grep, descriptions for Task. Tool events trigger `onContentBlockCommitted()`, allowing Haiku to re-observe with fresh tool context.

### Changed

- **HaikuObserver Rewritten with Iteration Loop**: Replaced the early-call + finalize pattern with an explicit state machine (`idle` → `running` → `waiting` → `done`) and iteration loop. Haiku fires on the first `onContentBlockCommitted()`, then re-observes whenever the buffer grows during a call (new tool results arrived). The loop continues until the buffer stabilizes and the main response completes. Streaming callbacks (`onIterationStart`, `onStreamDelta`, `onIterationComplete`) enable real-time UI updates. The `fireNextIteration()` method sets `observerState = 'running'` synchronously before the async call, making the state transition explicit.
- **ContextStore Refactored to In-Memory Only**: Removed all disk I/O from `ContextStore` (debounced writes, `loadFromDisk()`, `flush()`, file paths, timers). `HaikuActivityStore` is now the single source of truth for disk persistence via per-prompt `context.md` snapshots. `ContextStore` is a pure in-memory document holder used only by `getContextForInjection()`. Session resume loads the latest snapshot from `HaikuActivityStore.loadLatestContextSnapshot()` into `ContextStore.loadContent()`.
- **Per-Prompt Directory Structure**: Haiku activity files organized into `prompt-N/` directories instead of flat files. Each directory contains `haiku.jsonl` and `context.md`. Directory scanning uses `readdir({ withFileTypes: true })` filtered by `isDirectory()`.
- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.34` to `^0.2.37`.

### Fixed

- **Missing Store Reset on Session Boundaries**: Added `haikuObserverStore.$reset()` to both `sessionCleared` and `conversationCleared` handlers. Without this, stale haiku activities, streaming state, and overlay visibility persisted across session boundaries.
- **i18n Plural Placeholder**: Fixed `earlierIterations` translation key using `{count}` instead of `{n}`. vue-i18n's `t(key, number)` auto-injects the count as `{n}` — the `{count}` placeholder rendered as literal text instead of the number.
- **Dead Re-export**: Removed unused `FlushedAssistantData` type re-export from `claude-session/types.ts`.

### Removed

- **ContextViewOverlay**: Deleted `ContextViewOverlay.vue` and `useContextViewStore.ts`. The read-only context viewer is replaced by the iteration-aware `HaikuObserverOverlay` with per-prompt navigation and "Open Context File" button.
- **Auto-Generated Session Titles**: Removed the `maybeGenerateTitle` heuristic that parsed `## Goal` from Haiku's context document to name distill sessions. Deleted `onTitleGenerated` callback, `_titleGenerated` guard, and the `appendSessionTitle` wiring in `session-manager.ts`.
- **Dead Message Types**: Removed `showContextContent`, `haikuProcessing`, and `openSessionContext` from the message protocol. Replaced with granular iteration events (`haikuIterationStart`, `haikuStreamDelta`, `haikuIterationComplete`, `haikuActivityLoaded`) and per-prompt file openers (`openHaikuLog`, `openContextFile`).

## [1.1.3] - 2026-02-07

### Added

- **Per-Panel Context Strategy**: The context strategy setting (`default` / `distill`) is now per-panel, completing the per-panel settings trio alongside model and betas. Previously, changing the context strategy was a global workspace setting that affected all panels simultaneously. New `ContextStrategyManager` class follows the same dual-level pattern: per-panel in-memory `Map<string, ContextStrategy>` with a workspace-wide default for new panels persisted to `damocles.contextStrategy` config. The settings panel shows "This panel" and "Default for new panels" dropdowns. Changing a panel's strategy clears that panel's conversation and reinitializes its `ContextDistillationService` — other panels are unaffected. Re-selecting the already-active strategy is a no-op (no conversation clear). `ContextDistillationService` no longer reads from `vscode.workspace.getConfiguration` directly — the strategy is injected via constructor parameter, improving testability. Removed `contextStrategy` from `ExtensionSettings` — strategy state now flows exclusively through the dedicated `contextStrategyUpdate` message channel.

## [1.1.2] - 2026-02-07

### Added

- **Per-Panel Model Selection**: Each panel can now independently select a model while maintaining a workspace-wide default. The settings panel shows two model selectors — "This panel" (applies immediately to the current session via `session.setModel()`) and "Default for new panels" (persisted to VS Code config `damocles.model`, inherited by new panels on creation). New `ModelManager` class mirrors the `ProviderManager` dual-level pattern with in-memory per-panel overrides (`Map<string, string>`) and `modelUpdate` message broadcasts. Changing the default does not affect any existing panel's session. Removed `model` from `ExtensionSettings` — model state now flows exclusively through the dedicated `modelUpdate` message channel.
- **Per-Panel Beta Settings**: Beta toggles (e.g., 1M context) are now per-panel, matching the model dual-level pattern. Previously, toggling 1M context in one panel wrote to the global `damocles.betasEnabled` config, so switching models in Panel A could strip the beta from Panel B. New `BetaManager` class stores per-panel betas in a `Map<string, string[]>` — each panel gets its own copy seeded from config defaults on creation and cleaned up on dispose. Toggling only mutates that panel's entry (never writes to VS Code config). Model-change cleanup is scoped: switching from Sonnet to Haiku in Panel A only removes the incompatible 1M beta from Panel A's betas. Betas flow to the SDK via `session.setBetas()` and to the webview via the new `betaUpdate` message type. Removed `betasEnabled` from `ExtensionSettings` — beta state now flows exclusively through the dedicated per-panel channel.

## [1.1.1] - 2026-02-07

### Added

- **Secondary Sidebar View**: Damocles now appears in the VS Code secondary sidebar (right side), alongside tools like Claude Code and Copilot Chat. Uses the `WebviewViewProvider` API with a `WebviewHost` adapter pattern that normalizes `WebviewPanel` and `WebviewView` behind a unified interface. Both the editor panel (`Ctrl+Shift+U`) and sidebar view share the same initialization path via `PanelManager.initializeHost()`, so all features work identically in both modes. The two modes can coexist — open a panel in the editor area and a sidebar view simultaneously with independent sessions.

### Changed

- **WebviewHost Adapter Pattern**: Refactored all panel management code from raw `vscode.WebviewPanel` to a `WebviewHost` interface with `createPanelHost()` and `createViewHost()` adapter factories. All managers, handlers, and message routing now use the host abstraction, enabling any webview surface to be used as a chat target.

## [1.1.0] - 2026-02-06

### Added

- **Context Distillation (Beta)**: New `distill` context strategy as an alternative to the SDK's built-in session resume and auto-compact. Each query runs as a **stateless SDK session** while a **Haiku background observer** maintains a living context document (Goal, Current State, Key Files, Decisions, Notes) that is injected as a system prompt prefix on every turn. Haiku fires an early update at 8K chars of streamed output and a final update on response completion, keeping the context document fresh. Context is persisted to `~/.damocles/context/<sessionId>.context.md` and survives VS Code restarts. Enable via `damocles.contextStrategy: "distill"` in settings or the new "Context Strategy" dropdown in the settings panel.
- **Context View Overlay**: Full-screen overlay (sparkles icon in the chat header, visible only in distill mode) showing the live distilled context document rendered as markdown. Includes "Open in Editor" button. The sparkles icon shows a spinning border animation when Haiku is actively processing.
- **Distill Session Persistence**: Client-side JSONL persistence writes user and assistant entries to the standard `~/.claude/projects/` session files with `parentUuid` chain tracking. Sessions are annotated with a "Distill" badge in the session picker. Cross-mode loading is blocked with a warning notification.
- **Haiku Wait Gate**: `sendMessage()` blocks until any pending Haiku processing completes before starting the next turn, ensuring follow-up messages always get fresh context. Zero delay when no Haiku is running.
- **Auto-Generated Session Titles**: Distill sessions are automatically named from the `## Goal` heading in the Haiku-generated context document.

### Fixed

- **Cross-Mode Isolation (8 fixes)**: Fixed `cancel()`, `queueInput()`, and `rewindFiles()` using the rotating ephemeral SDK session ID instead of the stable persistence ID in distill mode. Fixed unsafe mid-session context strategy switch, stale distill state surviving `/clear`, broken `parentUuid` chains in `readActiveBranchEntries()`, and missing input sanitization in `appendSessionTitle()`. Removed 3 dead message types from the discriminated union.
- **Resource Lifecycle**: Panel close and extension deactivation now properly dispose the `ContextDistillationService`, flushing pending context writes and aborting in-flight Haiku calls. Added 30-second timeout to Haiku observer calls to prevent indefinite hangs. Reset `contextViewStore` on session clear to prevent stale spinner/content across sessions.
- **Stale Callback Cleanup**: Fixed `onTurnComplete`/`onTurnEndFlush` callbacks never being nulled in distill mode when a query completes, which could cause stale closures to reference dead query state.
- **Git Branch in Distill Persistence**: Assistant entries written by distill mode now record the actual git branch instead of hardcoding `main`.

### Changed

- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.33` to `^0.2.34`.
- **Dual Session ID Architecture**: In distill mode, `ClaudeSession` maintains a stable `persistenceSessionId` (for JSONL, checkpoints, webview) and a rotating `sessionId` (regenerated per SDK query). Session conflict recovery detects "already in use" collisions and auto-regenerates the SDK session ID.

## [1.0.65] - 2026-02-06

### Fixed

- **Early Session ID Resolution**: Extracted `session_id` from the SDK's init system message (the very first message emitted) instead of waiting for the first assistant message. Previously, `sessionId` was `null` for ~100-500ms after query start, causing downstream consumers (session persistence, memory injection, hook handlers) to fall back to `panelId`. The init message is now the single canonical extraction point — the redundant extraction in the assistant processor was removed.

## [1.0.64] - 2026-02-06

### Fixed

- **List Markers Missing in Chat**: Fixed numbered lists and bullet lists rendering without their markers (e.g., `1. item` displaying as just `item`). Tailwind v4's Preflight globally resets `list-style: none` on all `ol`/`ul` elements. The `MarkdownRenderer` scoped styles restored margin and padding but never restored `list-style-type`. Added `list-style-type: decimal` for `ol` and `list-style-type: disc` for `ul` within the `.markdown-renderer` scope.

### Changed

- **Prompt-Aware Memory Ranking**: Memory injection now uses the user's prompt to rank which memories are surfaced. The existing FTS5 full-text index (BM25) scores each memory against the prompt terms, replacing the previous binary file-proximity signal as the dominant ranking factor. New weight distribution: FTS relevance (0.4), recency (0.25), tier weight (0.15), file proximity (0.1), access frequency (0.1). When FTS5 returns no matches (generic prompts like "hi", image-only messages, or all-stopword prompts), falls back to the original recency-dominant scoring unchanged. Stopwords and FTS5 operators are filtered from the prompt before querying. BM25 ranks are normalized independently within each tier to prevent cross-tier score skew.
- **Observation Progressive Disclosure**: Injected observations now render as title + ID only (e.g., `[abc123] Fixed auth race condition`). The system prompt instructs Claude to call `get_memory_details` with the ID when an observation looks relevant, retrieving the full narrative, facts, and implementation details on demand.

## [1.0.63] - 2026-02-05

### Changed

- **Default Model Updated to Opus 4.6**: Updated the default model from `claude-opus-4-5-20251101` to `claude-opus-4-6`. The Claude Agent SDK handles adaptive thinking internally when Opus 4.6 is used — no changes needed to the thinking token configuration. The existing thinking tokens slider continues to work as guidance for adaptive thinking.

## [1.0.62] - 2026-02-05

### Added

- **Custom Permission Rules**: Persistent permission patterns stored in Claude Code CLI-compatible settings files (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`). Patterns are evaluated in priority order: local > project > user local > user global. First match wins. Supports `allow`, `deny`, and `ask` behaviors with pattern syntax matching Claude Code CLI (e.g., `Bash(git:*)`, `Edit(*.ts)`, `Write(src/**)`).
- **Always Allow / Always Deny**: Permission prompts now include "Always allow {pattern}" and "Always deny {pattern}" options with SDK-suggested patterns. Selecting either opens a destination picker to choose where to save the rule (local, project, or global settings file).

### Fixed

- **Deny Rules Ignored in Default Mode**: Fixed permission patterns from settings files not being evaluated when using the default permission mode. Deny rules now take precedence regardless of mode — if you explicitly deny `Bash(rm:*)`, it will be denied without prompting.
- **Session History Selectbox Not Updating**: Fixed new sessions not appearing in the session picker until panel refresh. Two issues: (1) the file watcher was missing an `onDidChange` handler — only `onDidCreate` and `onDidDelete` were subscribed, so modifications (assistant responses appended) were never detected; (2) `getSessionDirSync` didn't check path variations like its async counterpart, causing watcher setup to fail for workspaces with underscores in the path (SDK encodes `_` as `-`). Added debounced `onDidChange` handler (300ms) to batch rapid file writes and made `getSessionDirSync` consistent with `getSessionDir`.

### Changed

- **Permission Evaluation in PreToolUse Hook**: Moved permission evaluation from the SDK's `canUseTool` callback to the `PreToolUse` hook, which fires before any SDK permission logic. This allows custom rules to short-circuit SDK's built-in permission flow via `permissionDecision: 'allow' | 'deny'` in the hook output.

## [1.0.61] - 2026-02-04

### Fixed

- **Processing Indicator Lost on Plan Clear-Context (Linux)**: Fixed the processing indicator (loader/pause button) not appearing when clicking "Clear context & auto-accept" in plan view, making it impossible to interrupt the stream. The SDK's `SessionEnd` lifecycle hook from the aborted old query fired asynchronously after the new query set `processing: true`, sending a stale `sessionEnd` message to the webview which unconditionally called `setProcessing(false)`. SDK hooks bypass the `queryGeneration` stale-check mechanism in the streaming pipeline. Fix: guard the `SessionEnd` hook with an `isProcessing` check to suppress stale firings, remove the redundant `setProcessing(false)` from the webview `sessionEnd` handler (processing state now flows exclusively through the dedicated `processing` message type), and move `processing = true` before `await ensureStreamingQuery()` to eliminate the original async gap.

## [1.0.60] - 2026-02-04

### Fixed

- **Node ENOENT on Linux / VS Code Remote Server**: Fixed `spawn node ENOENT` when the Claude Agent SDK calls `child_process.spawn('node', ...)` but Node.js is not on the extension host's `PATH`. This occurs on Linux systems where Node.js is installed via NVM/fnm (shell profiles not sourced by the VS Code Server daemon) or where VS Code Server uses its own bundled binary. The fix prepends `process.execPath`'s directory to `PATH` in the SDK environment, ensuring `spawn('node')` resolves to the same binary running the extension host. Cross-platform safe via `path.delimiter`. Supersedes the v1.0.13 approach (reverted in v1.0.20) which was too broad — this targets only the current runtime binary.

## [1.0.59] - 2026-02-04

### Fixed

- **Linux WASM Permission Fix**: Fixed extension failing to activate on Linux when VSIX is packaged on Windows. The `sql.js-fts5` WASM and JS files lost read permissions during cross-platform packaging. Extended `fixPackagePermissions` to set `0o644` on `sql-wasm.js` and `sql-wasm.wasm`. Consolidated permission entries into a single data-driven loop with proper error discrimination (ENOENT silently skipped, other errors logged).
- **Robust WASM Loading**: Replaced Emscripten's fragile `__dirname`-based WASM path resolution with explicit `wasmBinary` pre-loading. The WASM binary is now read via `fs.readFileSync` using the known extension path and passed directly to `initSqlJs({ wasmBinary })`, bypassing all internal path guessing.
- **Memory MCP Server on Linux**: Fixed `Cannot find module 'zod'` — the SDK declares zod as a `peerDependency` which `.vscodeignore` excluded from the VSIX. Added `zod` as a direct dependency and whitelisted it in `.vscodeignore`. Switched `getMcpServerConfig` from fragile `async import()` to synchronous `require()`, consistent with how esbuild externalizes all runtime dependencies.

### Added

- **SDK Debug Mode**: `damocles.debug` (boolean) and `damocles.debugFile` (string) settings to enable SDK debug logging. Setting `debugFile` implicitly enables debug mode and writes verbose output to the specified path.

### Changed

- **Decoupled Database Module**: `initSqlEngine` now accepts `extensionPath: string` instead of `vscode.Uri`, removing the `vscode` import from the pure data layer module. All `console.error` calls in `database.ts` replaced with `log()` for output channel visibility.

### Removed

- **Auto-Summary Memory Tier**: Removed the `auto-summary` tier entirely, reducing the memory system from 6 tiers to 5 (session, project, global, note, observation). The auto-summary feature intercepted SDK compaction summaries and stored them for session handoff — this duplicated what the SDK's built-in compaction already provides. Deleted `auto-summary-manager.ts`, removed the `onMessage` wrapper in `ClaudeSession`, purged existing rows via V2 database migration, and updated the `MemoryTier` type union for compile-time enforcement. Session handoff now relies solely on observations. SDK compaction (`compactSummary`, `/compact`) is preserved unchanged.

## [1.0.58] - 2026-02-03

### Added

- **Persistent Memory System**: 6-tier memory architecture (session, project, global, notes, observations, auto-summaries) stored in WASM-based SQLite (`sql.js-fts5`) at `~/.damocles/memory.db` with universal FTS5 full-text search. No native modules — works cross-platform without compilation. Memories persist across compactions and sessions, giving Claude continuity between conversations.
- **Slash Commands for Memory**: `/remember <text>` saves a session memory (prefix with `project:` or `global:` for broader scope), `/note <text>` saves to a searchable knowledge base, `/memories` opens the memory management panel.
- **Observation System**: Claude voluntarily records rich observations via the `save_observation` MCP tool — structured entries with type, title, narrative content, facts, tags, and file paths. Observations persist across sessions and are searchable.
- **In-Process MCP Server**: 6 auto-approved tools (`save_observation`, `search_memories`, `get_memory_details`, `get_timeline`, `save_note`, `list_notes`) served via an in-process SDK MCP server with lazy ESM initialization. Progressive disclosure: `search_memories` returns a compact index (~30 tokens/result), `get_memory_details` returns full content on demand.
- **Adaptive Context Injection**: Every prompt is enriched with relevance-weighted memories. Scoring combines file proximity (active editor), recency, tier priority, and access frequency. Each tier has an independent configurable token budget (session: 1000, project: 800, global: 500, observation: 500).
- **Smart Session Handoff**: First message of a new session automatically receives the previous session's auto-summary and top-ranked observations from recent sessions, weighted by file proximity to the active editor.
- **Auto-Summary Capture**: Compaction summaries are intercepted at the ClaudeSession level and stored as project-scoped auto-summaries (retains last 3 per workspace). The most recent auto-summary is included in session handoff context when starting a new session.
- **Memory Panel**: 6-tab full-screen overlay (Session, Project, Global, Notes, Observations, Summaries) following the same pattern as PlanViewOverlay and SubagentOverlay. Features quick-add inputs for editable tiers, universal search bar, delete buttons, empty states, and escape-to-close.
- **Memory Settings**: 6 new VS Code settings under `damocles.memory.*` for enabling/disabling the system and configuring per-tier token budgets.

## [1.0.57] - 2026-02-02

### Fixed

- **Plan Mode Auto-Switch on EnterPlanMode**: Fixed the ChatInput permission mode badge not switching to "Plan" when Claude calls `EnterPlanMode`. The SDK auto-allows `EnterPlanMode` internally (before the `canUseTool` callback), so the extension's permission state was never updated. Moved plan mode activation into the `PostToolUse` hook, which fires for all tools regardless of how they were permitted. Added idempotent `activatePlanMode()` method to `PlanManager`/`PermissionHandler` that syncs extension state and pushes `settingsUpdate` to the webview.

### Changed

- **Removed EnterPlanMode Webview Approval Flow**: Removed the webview round-trip approval prompt for `EnterPlanMode` since entering plan mode is a harmless read-only restriction (the real user gate is `ExitPlanMode` where the plan is reviewed). Deleted `EnterPlanModePrompt.vue` component, associated permission store state, message types, and i18n keys. `EnterPlanMode` is now auto-approved for all permission modes.

## [1.0.56] - 2026-02-01

### Fixed

- **Plan Mode Preserved on Tool Approval**: Fixed "Yes, accept all edits" and "Yes, don't ask again" buttons incorrectly switching the permission mode from `plan` to `acceptEdits`. Both `handlePermissionApproval()` and `handleSkillApprove()` now check the current mode before changing it, preserving plan mode while still forwarding the approval flags to the extension for subagent auto-approval and skill pre-approval tracking.
- **Strict Mode Violations (Batch 3)**: Resolved 105 TypeScript errors across 28 files left over from the v1.0.54 strict mode enablement. Applied conditional spread for optional properties (`exactOptionalPropertyTypes`), bracket notation for index signature properties (`noPropertyAccessFromIndexSignature`), null guards for array index access (`noUncheckedIndexedAccess`), and explicit type annotations for exports (`isolatedDeclarations`). Affected modules: `permission-handler/managers/`, `chat-panel/` (history-manager, session-manager, settings-manager, message-router handlers), `claude-session/` (query-manager, tool-manager, streaming-manager processors, hook-handlers, checkpoint-manager, index), `SlashCommandService`, `CustomAgentService`, `PluginService`, `DiffManager`, `extension.ts`, `session/types.ts`.

## [1.0.55] - 2026-01-30

### Fixed

- **Strict Mode Violations (Batch 2)**: Resolved 87 TypeScript errors across 9 files left over from the v1.0.54 strict mode enablement. Applied null guards for array index access (`noUncheckedIndexedAccess`), conditional spread for optional properties (`exactOptionalPropertyTypes`), and bracket notation for index signature properties (`noPropertyAccessFromIndexSignature`). Affected files: `session/reading.ts`, `session/branches.ts`, `session/writing.ts`, `session/paths.ts`, `streaming-manager/processors/system-processor.ts`, `claude-session/utils.ts`, `permission-handler/utils.ts`, `skills/utils.ts`, `shared/utils.ts`.

## [1.0.54] - 2026-01-30

### Changed

- **Strict TypeScript Configuration**: Enabled maximum strictness flags beyond `strict: true` in both `tsconfig.json` and `tsconfig.webview.json`. Added `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedDeclarations`, `erasableSyntaxOnly`, and `noUncheckedSideEffectImports`. Removed `esModuleInterop` (superseded by `verbatimModuleSyntax`).
- **Explicit Field Declarations**: Converted all 27 constructor parameter properties across 13 files to explicit field declarations with manual constructor assignment, as required by `erasableSyntaxOnly`. Affects `ChatPanelProvider`, `CheckpointManager`, `QueryManager`, `StreamingState`, `ToolManager`, `CustomAgentService`, `PluginService`, `SlashCommandService`, and all `PermissionHandler` managers.
- **Index Signature Access**: Changed dot notation to bracket notation for index signature properties (`process.env`, Claude settings, SDK input objects) across 7 files to satisfy `noPropertyAccessFromIndexSignature`.
- **Type-Only Re-exports**: Changed `export { SessionOptions }` to `export type { SessionOptions }` in `claude-session/index.ts` for `verbatimModuleSyntax` compliance.

### Fixed

- Removed unused imports (`log`, `ImageBlock`, `readSessionFileLines`, `createEmptyStreamingContent`, `HistoryToolCall`, `HistoryAgentMessage`) and prefixed unused destructured variables with `_` across 10 files.
- Removed dead `invalidateSessionsCache` field from `PanelManager` (stored from config but never read; cache invalidation uses `StorageManager` directly).

## [1.0.53] - 2026-01-30

### Fixed

- **Context Warning Dismiss Interrupting Claude**: Fixed dismissing the context warning banner unconditionally sending `cancelAutoCompact`, which corrupted the context monitor state and interrupted Claude's processing even when no auto-compact was active. The dismiss handler now only cancels when `autoCompactTriggered` is true.

## [1.0.52] - 2026-01-30

### Fixed

- **Streaming Store Race Conditions**: Fixed messages disappearing, content being overwritten, and out-of-order event corruption in the streaming store. Replaced the mutable singleton pointer pattern with SDK message ID targeting so late-arriving events always reach their target message. Introduced monotonic merge semantics — text/thinking use longest-wins (cumulative), toolCalls use ID-based merge with status priority, and contentBlocks use union semantics for `tool_use` blocks (preserving all distinct tools from both arrays). Removed forced finalization (`checkAndFinalizeForNewMessageId`) that was prematurely orphaning messages; `getOrCreateStreamingMessage` now handles message transitions with proper adopt-or-create logic for the permission handler path.
- **Parallel Subagent Cards Not Rendering**: Fixed only the first agent card appearing when Claude launches multiple Task tools in parallel. The `contentBlocks` merge was using "longest array wins" — correct for cumulative text but incorrect for heterogeneous arrays containing distinct `tool_use` blocks. The extension's streaming content singleton resets between main/subagent message switches, causing subsequent `toolStreaming` events to carry partial `contentBlocks`. The merge now uses union-by-ID for `tool_use` blocks (matching the existing `mergeToolCalls` strategy), ensuring all agent cards render regardless of event ordering.

## [1.0.51] - 2026-01-29

### Fixed

- **ESC Key During Auto-Compact**: Fixed ESC key not dismissing the "Auto-compacting..." banner when pressed during auto-compact. The `cancel()` method now clears the pending compact timer and resets the context monitor state when auto-compact was triggered, matching the behavior of the X button.

## [1.0.50] - 2026-01-28

### Fixed

- **Tool Card Hover Overlay**: Fixed "Click to expand" overlay incorrectly appearing when hovering over the file path header or when hovering over any tool card when multiple tools ran in parallel. The overlay now only appears when hovering over the diff content area of a specific tool card.

## [1.0.49] - 2026-01-28

### Added

- **Context Warning Banner**: Visual context usage monitoring with graduated threshold system. Shows warnings at `warningThreshold` (yellow), `softThreshold` (orange), and `hardThreshold` (red). Banner displays token count, percentage, and progress bar. Configurable via `damocles.autoCompact` settings.
- **Auto-Compact** (opt-in): Automatic `/compact` injection when context reaches `hardThreshold`. Disabled by default — enable via `damocles.autoCompact.enabled`. Addresses the limitation where the SDK's built-in compaction at ~77% can fail when large tool results flood the context.

## [1.0.48] - 2026-01-28

### Changed

- **Modularized SettingsManager**: Refactored monolithic `settings-manager.ts` (608 lines) into a modular `settings-manager/` directory. Managers are now organized by domain (MCP servers, plugins, provider profiles, VS Code config) with each manager owning its internal state. Uses dependency injection for manager wiring in facade. Pure helper functions extracted to `utils.ts`. No centralized state class since domains are independent (unlike PermissionHandler which shares state).

## [1.0.47] - 2026-01-28

### Changed

- **Updated Taglines**: Updated README and translations with new project tagline.

## [1.0.46] - 2026-01-27

### Changed

- **Renamed Extension to Damocles**: Rebranded from "Claude Unbound" to "Damocles". Updated all identifiers including extension ID (`damocles`), command prefixes (`damocles.*`), settings keys, webview panel types, output channel name, repository URLs, and documentation. The name references the Sword of Damocles — "with great power comes great responsibility" — reflecting the extension's philosophy of providing powerful AI capabilities while maintaining vigilant permission controls.

## [1.0.45] - 2026-01-27

### Changed

- **Modularized PermissionHandler**: Refactored monolithic `PermissionHandler.ts` (685 lines) into a modular `permission-handler/` directory following the established architectural patterns. Managers are now organized by domain (approval, question, plan, skill, subagent) with centralized state management in `PermissionState` class. Uses dependency injection for manager wiring. Pure helper functions extracted to `utils.ts`.

## [1.0.44] - 2026-01-27

### Fixed

- **Dot-Namespaced Commands Not Discovered**: Fixed slash commands with dots in their names (e.g., `speckit.plan`, `speckit.analyze`) being silently filtered out during discovery. The `VALID_COMMAND_NAME` regex now allows dots as namespace separators while still preventing malformed names like `.hidden`, `trailing.`, or `double..dot`.

## [1.0.43] - 2026-01-27

### Changed

- **Modularized useMessageHandler**: Refactored monolithic `useMessageHandler.ts` (820 lines) into a modular `message-handler/` directory following the established `message-router/` pattern from the extension side. Handlers are now organized by domain (streaming, tools, permissions, sessions, settings, history, subagents, queue, UI) with a registry-based dispatch system. Uses factory pattern with `Partial<HandlerRegistry>` for type-safe composition.

## [1.0.42] - 2026-01-27

### Fixed

- **Skills Not Refreshing Without Restart**: Fixed new skills in `.claude/skills/` not appearing in `/` autocomplete until VS Code restart. Added directory watchers alongside file watchers to detect when new skill folders are created. This is the VS Code-recommended dual-watcher pattern for glob patterns with exact filenames.

## [1.0.41] - 2026-01-27

### Changed

- **Modularized StreamingManager**: Refactored monolithic `streaming-manager.ts` (785 lines) into a modular `streaming-manager/` directory following the established `message-router/` pattern. Message processors are now organized by type (assistant, stream-event, system, user, result) with centralized state management in `StreamingState` class. Uses factory pattern for processors with dependency injection. Pure helper functions extracted to `utils.ts`.

## [1.0.40] - 2026-01-27

### Changed

- **Modularized Shared Types**: Refactored monolithic `src/shared/types.ts` (839 lines) into 10 focused domain modules in `src/shared/types/`. Types are now organized by domain: constants, content, mcp, plugins, commands, permissions, settings, session, subagents, and messages. Updated 55+ files across webview and extension to use domain-specific imports. No barrel re-export - explicit dependencies only.

## [1.0.39] - 2026-01-27

### Fixed

- **Session Name Not Showing on New Session**: Fixed picker trigger button showing "New Session" instead of the actual session name when creating a new session.

## [1.0.38] - 2026-01-26

### Changed

- **Modularized Hook Handlers**: Extracted ~250 lines of SDK hook configuration from `QueryManager` into dedicated `hook-handlers.ts` module. Hooks are now organized by domain (tool, lifecycle, user, subagent) with dependency injection for improved testability. Follows the established `claude-session/` modular pattern.

## [1.0.37] - 2026-01-26

### Added

- **Session Search**: Search through sessions by name in the session picker dropdown. Type to filter sessions with 300ms debounce. Clear search to return to paginated view.

### Changed

- **Session Picker Refactored**: Extracted session picker into dedicated `SessionPicker.vue` component with proper separation of concerns. Search, rename, delete, and infinite scroll functionality are now self-contained.

## [1.0.36] - 2026-01-24

### Changed

- **Task System UI**: Replaced the legacy `TodoWrite`-based todo system with the SDK's richer `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` tools. New features include task IDs, subjects, descriptions, dependency tracking (`blockedBy`/`blocks`), owner assignment, and metadata. Tasks are managed in a dedicated `useTaskStore` with input tracking pattern to handle incremental updates.

## [1.0.35] - 2026-01-24

### Changed

- **Modularized Message Router**: Refactored `message-router.ts` (898 lines) into a modular `message-router/` directory following the established `claude-session/` pattern. Handlers are now organized by domain (chat, permissions, settings, sessions, history, workspace, providers) with a thin facade and dependency injection.

## [1.0.34] - 2026-01-23

### Fixed

- **Prompt History Not Syncing Across Panels**: Fixed two issues preventing prompt history from syncing correctly: (1) cache not being invalidated when broadcasting new entries, causing newly opened panels to show stale history; (2) race condition where prompts submitted in a single-panel session weren't available when opening a new panel before the SDK wrote to disk. Implemented pending entries buffer that merges with disk history on cache rebuild.

### Changed

- **Renamed Command History to Prompt History**: Updated terminology throughout codebase and documentation to use "prompt history" instead of "command history" for better clarity.

## [1.0.33] - 2026-01-22

### Added

- **Subagent-Scoped Accept All**: When clicking "Accept all edits" on a subagent's permission prompt, only that subagent's subsequent tools are auto-approved. The global session mode (e.g., Plan mode) remains unchanged. This allows granular permission control where each subagent can be independently auto-approved without affecting the main session or other subagents.
- **Agent Attribution in Permissions**: Permission prompts now show which agent is requesting the action (e.g., "Explorer agent wants to run this command:") for better visibility into subagent behavior.

## [1.0.32] - 2026-01-22

### Added

- **YOLO Mode**: New toggle button that auto-approves all tool calls (except plan approval and questions). Ephemeral per-panel setting that resets on session clear and VS Code restart. Replaces the previous `bypassPermissions` mode.

### Changed

- **Removed `bypassPermissions` Mode**: The persisted `bypassPermissions` permission mode has been removed from VS Code settings.

## [1.0.31] - 2026-01-21

### Added

- **Image Preview in Chat Input**: Attached images in the chat input can now be clicked to open a full-screen preview, matching the behavior of images in sent messages.

### Fixed

- **Textarea Overflow in Constrained Panels**: Textareas in overlay prompts (AskUserQuestion, PermissionPrompt, SkillApproval, EnterPlanMode, PlanApproval) now scroll when content exceeds container height instead of pushing buttons out of view. Added `overflow-y-auto` to base Textarea component and `max-h-32` constraints to prompt textareas. Answer preview in question submit tab also constrained with scrolling.
- **HTML Rendered Instead of Displayed**: Fixed raw HTML in chat messages being rendered as actual DOM elements instead of displayed as text. For example, `<span>ID</span>` now shows as literal text rather than just "ID".

## [1.0.30] - 2026-01-21

### Fixed

- **Dynamic Cache Updates**: Fixed caches not propagating changes to webview panels. Session history, slash commands, skills, MCP servers, plugins, and custom agents now update automatically when underlying files change, without requiring panel refresh.
- **MCP Server File Watcher**: Added file watcher for `.mcp.json` - changes to MCP server configuration are now detected and reflected in the settings panel immediately.

## [1.0.29] - 2026-01-21

### Changed

- **Namespaced Slash Commands**: Commands in subdirectories (e.g., `~/.claude/commands/gsd/`) now display as `/gsd:command-name` instead of showing a separate badge, matching the plugin command naming convention
- **Improved Badge Visibility**: Source badges (plugin, user) now use neutral colors with border for better visibility across light and dark themes

## [1.0.28] - 2026-01-20

### Changed

- **Performance Optimization**: Panel loading reduced from 20-30s to ~2s first load, ~16ms cached. Single-pass entry processing extracts all data in one iteration instead of 5+ passes. Parallelized session listing and command history extraction. Added caching for sessions list and command history. Removed aggressive cache invalidation on panel focus.

### Fixed

- Fix race condition where panels would get stuck loading when webview sent `ready` before message listener was attached. Message queue now buffers early messages until panel initialization completes.

## [1.0.27] - 2026-01-18

### Added

- **Clear Context & Auto-Accept**: New plan approval option that clears conversation and starts fresh with the plan injected. Matches Claude Code CLI behavior: preserves planning session, creates new implementation session. Plan content injected as first message with transcript reference to original planning session. Permission mode automatically set to "acceptEdits" for streamlined implementation.

## [1.0.26] - 2026-01-17

### Added

- **Bind Plan to Session**: New link icon button in chat header to inject a custom plan file into the session. File picker opens to workspace folder by default, filtered to markdown files. If session already has a plan slug, it writes file directly and sends a system message informing Claude of the update. If session has no plan slug, it temporarily enters plan mode and notifies Claude via systemMessage after the acknowledgment.

## [1.0.25] - 2026-01-16

### Added

- MCP tool overlay now displays tool inputs in a collapsible "Input" section with JSON syntax highlighting
- MCP tool overlay responses now use JSON syntax highlighting when content is valid JSON
- "Show full response" button for large MCP tool responses (>2000 chars) with expand/collapse toggle

### Changed

- MCP tool overlay reorganized with collapsible "Input" and "Response" sections
- Tool results no longer truncated when loading session history (full data preserved, UI handles display truncation)

## [1.0.24] - 2026-01-16

### Fixed

- Fix Edit/Write tool cards not scrolling to edit line on fresh sessions when using `acceptEdits` or `bypassPermissions` mode
- Fix Edit/Write tool cards in subagent views not scrolling to edit line (both live and historical sessions)
- Extract `editLineNumber` from SDK tool result consistently across all contexts (main session, subagents, history)

## [1.0.23] - 2026-01-16

### Fixed

- Fix excessive vertical spacing between lines in code blocks (double line breaks caused by `white-space: pre` preserving newlines between Shiki-generated `.line` elements)
- Fix empty lines in code blocks collapsing to zero height (added `min-height` to preserve blank line spacing)

## [1.0.22] - 2026-01-15

### Added

- Clickable MCP tool cards now open a full-screen overlay displaying the tool's output with markdown rendering
- Official MCP (Model Context Protocol) icon for MCP tool cards and overlay
- Visual styling for MCP tool cards: gradient header background, primary color border

### Fixed

- Fix MCP tool output showing raw JSON instead of parsed text when loading sessions from history

## [1.0.21] - 2026-01-15

### Added

- Add Screenshots section to README showcasing chat interface, plan view, and subagent visualization

## [1.0.20] - 2026-01-15

### Changed

- **Revert v1.0.13 PATH detection** - Remove automatic Node version manager PATH detection (NVM, FNM, Volta, n, asdf) that was causing issues for some users by adding ALL installed versions to PATH
- Users who need custom PATH for MCP servers on Remote SSH should configure it via `.mcp.json` `env` field (per-server) or configure their shell for non-interactive use (see [Claude Code troubleshooting](https://code.claude.com/docs/en/troubleshooting))

## [1.0.19] - 2026-01-14

### Fixed

- Fix session history not loading for workspaces with spaces in the path (e.g., `C:\Projects\My Project`)

## [1.0.18] - 2026-01-14

### Added

- Clickable file paths in Edit/Write tool cards now open the file and scroll to the exact line where the edit occurred
- Works with both live edits and historical sessions loaded from session history

## [1.0.17] - 2026-01-14

### Fixed

- Extend Node path detection for MCP servers to include alternative FNM location (`~/.fnm/`) and `/usr/local/bin`
- Fix provider profile deletion not working due to race condition in AlertDialog event handling

## [1.0.16] - 2026-01-13

### Changed

- Extended thinking tokens setting now stored in VS Code settings instead of `.claude/settings.local.json`

## [1.0.15] - 2026-01-13

### Added

- Subagent overlay now displays full conversation history (previously only showed tool calls and final result)
- Markdown rendering for subagent prompt display (previously rendered as plain text)

### Fixed

- Tool count and duration now display correctly for interrupted subagents

## [1.0.14] - 2026-01-13

### Fixed

- Fix Shift+Enter not inserting newlines in prompt textareas (AskUserQuestion, permission prompts, skill approvals, plan mode)

## [1.0.13] - 2026-01-13

### Fixed

- Fix MCP servers failing to start on Remote SSH due to NVM/FNM paths not in PATH (VS Code Server doesn't source shell configs)

## [1.0.12] - 2026-01-12

### Fixed

- Fix SDK tools and agent discovery failing on Remote SSH due to ripgrep binary lacking execute permissions
- Revert workaround from 1.0.11 (SDK discovery now works with ripgrep fix)

## [1.0.11] - 2026-01-12

### Fixed

- Fix custom agents from `.claude/agents/` not loading on Remote SSH (bypass SDK filesystem discovery)

## [1.0.10] - 2026-01-10

### Fixed

- Fix provider profile settings unable to save to User Settings (changed scope from "resource" to "window")

## [1.0.9] - 2026-01-10

### Fixed

- Fix extension package including unintended files

## [1.0.8] - 2026-01-10

### Added

- Provider Profiles: Define multiple API provider configurations with custom environment variables
- Switch between providers (Anthropic, Z.AI, OpenRouter, etc.) from the settings panel
- Provider-specific model mapping via ANTHROPIC*DEFAULT*\*\_MODEL environment variables
- Secure credential storage: API keys encrypted via OS keychain (VS Code SecretStorage API), masked input fields in profile editor
- Per-panel provider profiles: Each open panel can have its own provider profile independent of other panels
- Global default profile setting: Configure which profile new panels inherit (separate from per-panel selection)

### Fixed

- Fix streaming text not being captured when assistant message contains non-streamed text content
- Fix concurrent streaming with different provider profiles causing race conditions
- Fix loose model tier matching to use explicit Claude model prefixes
- Add environment variable key validation in profile editor

### Changed

- Extended thinking now inherits SDK default when not explicitly configured (instead of forcing a value)

## [1.0.7] - 2026-01-10

### Fixed

- Fix memory leak when closing panel
- Call `reset()` instead of `cancel()` on panel dispose for proper SDK cleanup
- Clean up pending permission promises on dispose to prevent dangling references
- Add error resilience to PermissionHandler cleanup loops

## [1.0.6] - 2026-01-08

### Fixed

- Fix MCP server/plugin toggle failing when `settings.local.json` doesn't exist
- Fix settings path resolution to properly fall back from project to user settings
- Add error notifications when settings fail to save (MCP, plugins, thinking tokens, budget)

### Changed

- Default thinking tokens now 63999 (extended thinking enabled by default)

## [1.0.5] - 2026-01-08

### Added

- Skills can now be invoked directly via slash commands (`/skill-name`)
- Skills appear in slash command autocomplete alongside regular commands
- Skills invoked via slash command are auto-approved (no approval prompt needed)
- Plugin skills support with format `/plugin:skill-name`

## [1.0.4] - 2026-01-06

### Added

- Add "Open in Editor" button to plan view header

### Fixed

- Fix ESC incorrectly restoring prompt to ChatInput when streaming had already started
- Fix diff view ENOENT errors when temp directory was cleaned by OS

### Changed

- Refactor DiffManager to use VS Code virtual documents instead of temp files

## [1.0.3] - 2026-01-06

### Fixed

- Fix maxTurns default value in documentation (50 → 100)
- Remove outdated /context command reference

## [1.0.2] - 2026-01-05

### Fixed

- Remove empty "Unreleased" section from changelog

## [1.0.1] - 2026-01-05

### Fixed

- Include CHANGELOG.md in extension package

## [1.0.0] - 2026-01-05

### Added

- Initial release
- Chat interface with streaming responses
- Diff approval for file changes with syntax highlighting
- Tool visualization with real-time status
- Subagent visualization with nested view
- @ mentions for workspace files and agents
- Custom agents support from `.claude/agents/`
- Image attachments via clipboard paste
- IDE context injection (active file/selection)
- Slash commands with autocomplete
- Command history navigation (shell-style)
- Session management (create, rename, resume, delete)
- Panel persistence across VS Code restarts
- Multi-panel synchronization
- Context stats (tokens, cache, cost)
- Model selection (Opus, Sonnet, Haiku)
- Extended thinking mode with adjustable budget
- Per-panel permission modes
- Plan mode for implementation review
- File checkpointing and rewind
- Todo list visualization
- Message queue for tool boundary injection
- MCP server management
- Hooks and plugins support
- Skills approval workflow
- Localization (English, Greek)

[1.1.45]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.44...v1.1.45
[1.1.44]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.43...v1.1.44
[1.1.43]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.42...v1.1.43
[1.1.42]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.41...v1.1.42
[1.1.41]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.40...v1.1.41
[1.1.40]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.39...v1.1.40
[1.1.39]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.38...v1.1.39
[1.1.38]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.37...v1.1.38
[1.1.37]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.36...v1.1.37
[1.1.36]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.35...v1.1.36
[1.1.35]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.34...v1.1.35
[1.1.34]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.33...v1.1.34
[1.1.33]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.32...v1.1.33
[1.1.32]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.31...v1.1.32
[1.1.31]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.30...v1.1.31
[1.1.30]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.29...v1.1.30
[1.1.29]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.28...v1.1.29
[1.1.28]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.27...v1.1.28
[1.1.27]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.26...v1.1.27
[1.1.26]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.25...v1.1.26
[1.1.25]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.24...v1.1.25
[1.1.24]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.23...v1.1.24
[1.1.23]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.22...v1.1.23
[1.1.22]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.21...v1.1.22
[1.1.21]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.20...v1.1.21
[1.1.20]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.19...v1.1.20
[1.1.19]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.18...v1.1.19
[1.1.18]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.17...v1.1.18
[1.1.17]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.16...v1.1.17
[1.1.16]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.15...v1.1.16
[1.1.15]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.14...v1.1.15
[1.1.14]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.13...v1.1.14
[1.1.13]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.12...v1.1.13
[1.1.12]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.11...v1.1.12
[1.1.11]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.10...v1.1.11
[1.1.10]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.9...v1.1.10
[1.1.9]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.65...v1.1.0
[1.0.65]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.64...v1.0.65
[1.0.64]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.63...v1.0.64
[1.0.63]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.62...v1.0.63
[1.0.62]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.61...v1.0.62
[1.0.61]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.60...v1.0.61
[1.0.60]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.59...v1.0.60
[1.0.59]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.58...v1.0.59
[1.0.58]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.57...v1.0.58
[1.0.57]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.56...v1.0.57
[1.0.56]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.55...v1.0.56
[1.0.55]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.54...v1.0.55
[1.0.54]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.53...v1.0.54
[1.0.53]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.52...v1.0.53
[1.0.52]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.51...v1.0.52
[1.0.51]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.50...v1.0.51
[1.0.50]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.49...v1.0.50
[1.0.49]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.48...v1.0.49
[1.0.48]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.47...v1.0.48
[1.0.47]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.46...v1.0.47
[1.0.46]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.45...v1.0.46
[1.0.45]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.44...v1.0.45
[1.0.44]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.43...v1.0.44
[1.0.43]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.42...v1.0.43
[1.0.42]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.41...v1.0.42
[1.0.41]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.40...v1.0.41
[1.0.40]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.39...v1.0.40
[1.0.39]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.38...v1.0.39
[1.0.38]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.37...v1.0.38
[1.0.37]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.36...v1.0.37
[1.0.36]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.35...v1.0.36
[1.0.35]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.34...v1.0.35
[1.0.34]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.33...v1.0.34
[1.0.33]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.32...v1.0.33
[1.0.32]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.31...v1.0.32
[1.0.31]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.30...v1.0.31
[1.0.30]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.29...v1.0.30
[1.0.29]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.28...v1.0.29
[1.0.28]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.27...v1.0.28
[1.0.27]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.26...v1.0.27
[1.0.26]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.25...v1.0.26
[1.0.25]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.24...v1.0.25
[1.0.24]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.23...v1.0.24
[1.0.23]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.22...v1.0.23
[1.0.22]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.21...v1.0.22
[1.0.21]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.20...v1.0.21
[1.0.20]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.19...v1.0.20
[1.0.19]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.18...v1.0.19
[1.0.18]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.17...v1.0.18
[1.0.17]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/AizenvoltPrime/damocles/releases/tag/v1.0.0
