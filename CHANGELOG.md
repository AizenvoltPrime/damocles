# Changelog

All notable changes to Damocles will be documented in this file.

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
