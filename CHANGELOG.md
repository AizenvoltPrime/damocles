# Changelog

All notable changes to Damocles will be documented in this file.

## [1.8.14] - 2026-04-19

### Added

- **Inline Scroll-To-User-Message Arrow**: Up-arrow button inside the pinned sticky bubble smoothly scrolls the canvas back to the pinned message's natural position. Hidden during push/collide transitions (`activeOffset !== 0`). Respects `prefers-reduced-motion`
- **Image Chips Replace Thumbnail Previews**: `ImageChip.vue` + `UserMessageImageChip.vue` render pasted images as `icon + filename + WIDTH×HEIGHT` chips in both the input staging strip and sent user bubbles. Input path captures dimensions via a `new Image()` probe before the attachment is pushed. Sent-bubble path lazy-probes via `useImageBlockDimensions.ts` with a 128-entry LRU keyed on `${data.length}:${first-64-base64-chars}` for collision resistance. Sent bubbles derive filename from the block's `media_type` (`image.png`, `image.webp`, etc.)
- **Symmetric Push/Collide Sticky Header**: Consecutive user-message sticky headers physically push/collide in both scroll directions. Scroll-driven — no CSS animation, tracks the viewport exactly. `prefers-reduced-motion` snaps the offset to endpoints
- **Scrollbar-Drag Clears Visiting State**: Mousedown listener with target filtering (`ev.target === scrollContainer`) on the scroll container, so the scroll-to-primary visiting skip-semantic clears on scrollbar drag in addition to wheel/touch/key signals. Clicks on child elements (arrows, action buttons) do not trigger it

### Changed

- **Sticky Header Architecture**: Teleport-based pinning replaced with a dedicated `StickyUserHeader.vue` sibling-clone wrapper. Canvas bubbles always render at their virtualized position — no Teleport move/restore, no `reservedHeight` spacer, no `liftedMessageId` provide/inject. The always-present sibling clone is the prerequisite for symmetric push/collide
- **`useStickyHeader.update()` Rule**: Detection simplified to strict `topY < scrollTop`. New `activeOffset: Ref<number>` clamped to `[-stickyHeight, 0]`, computed from the gap between the next user-message's top and the sticky bottom
- **`ImageAttachment` Shape**: Gains required `width` and `height`, populated in `useImageAttachments.ts` before the attachment is pushed. If dimension probing rejects, the attachment is not added

### Fixed

- **Picked Element No Longer Silently Vanishes**: `postToActivePanel` callers in `extension.ts` and `chat-panel/index.ts` surface a warning message when no chat panel is open to receive the browser element pick
- **`ImageChip` Missing Focus-Visible Ring**: Chip buttons now show the standard `focus-visible:ring-2 ring-ring ring-offset-2` indicator for keyboard users
- **O(N) `indexOf` Removed From Sticky Prompt-Index Computation**: `stickyPromptIndex` now uses `sticky.activeItemIndex` + `items[idx].originalMessageIndex` instead of `props.messages.indexOf(msg)` — O(1) per winner change

## [1.8.13] - 2026-04-18

### Added

- **Inline Rewind On User Bubbles**: Copy + Rewind action row on every user message (hover/focus). Rewind skips the picker and opens the Restore Options modal directly scoped to that message with a loading spinner while metadata prefetches. Cancel routes back correctly per entry point (`rewindSource` tracks `'bubble'` vs `'picker'`)
- **Teleport Sticky User Header**: Scrolled-past user messages lift into a Teleport target at the pane's top — truly sticky, no virtual-list item swap. A `ResizeObserver` reserves the vacated height so scroll position stays stable. `StickyUserHeader.vue` and the `expandedStickies` map in `useStickyHeader.ts` are deleted
- **Affected Files In Rewind Popup**: Collapsible "N files affected" disclosure in the Restore Options modal. Files dedup by absolute path, displayed workspace-relative when inside the workspace. `data-no-keyboard-shortcuts` prevents 1/2/3/4 shortcuts from firing while the list has focus
- **Click-To-Diff From The List**: Clicking a file opens a VS Code side-by-side diff — "at checkpoint ↔ current" — using the SDK's pre-op `originalFile` snapshot. New `RewindDiffProvider` owns the `damocles-rewind:` scheme, auto-cleans on tab close, and reconciles `activeKeys` against open tabs on each show. Webview-supplied paths validated against workspace root via `WorkspaceManager.resolveWorkspaceFilePath`

### Changed

- **`checkpointInfo` Payload**: `{ checkpoints: MessageCheckpoint[] }` → `{ userMessageIds: string[] }`. `MessageCheckpoint` deleted. `broadcastCheckpoints` dedups on set size so identical re-sends are skipped
- **`RewindHistoryItem.files` Shape**: `string[]` → `Array<{ path: string; displayName: string }>` so the webview no longer re-derives display names

### Fixed

- **Dead-Branch Files Leaked Into Rewind Popup**: `extractRewindHistory` aggregated file changes from `readSessionEntries` (all branches, including ones abandoned by previous rewinds) while reading messages from `readActiveBranchEntries` — causing e.g. `helloworld6.ts` to appear under "create helloworld4.ts" after rewinding past the helloworld6 branch. Both loops now use `readActiveBranchEntries`. `getFileCheckpointContent` also scoped to branch entries via `conversationHead`
- **Edit Tool Results Dropped From The Files List**: Detection required a truthy `type`, but Edit results have only `filePath` + `structuredPatch`. Replaced with `isFileModifyingResult` that also accepts a non-empty `structuredPatch` array
- **Empty ↔ Current Diff On Partial SDK Results**: Missing `originalFile` now returns `null` (caller falls back to plain `openFile`) except when `type === 'create'`, where `""` is the correct pre-state
- **Rewind Button Missing On Fresh And Post-History Bubbles**: `rewindableUserIds` was only seeded from assistant-side `trackCheckpoint`. Resume path now calls `extractRewindableUserIds`; live path seeds each user message as its UUID is assigned

## [1.8.12] - 2026-04-18

### Fixed

- **Second Panel Silently Freezes the First Panel's Team**: Opening a second Damocles panel while a team ran in the first silently froze the first panel's TeamOverlay and TeamCard. Root cause: `TeamService` was a provider-owned singleton with four per-panel setters rewired during each panel's warmup — the second panel's wiring clobbered the first panel's `onMessage` callback, and all subsequent `teamAgent*` / `teamMessage` / `teamScratchpadUpdate` events routed to a panel with no matching overlay
- **Log Spam on Every Config Rescan**: `[auth-bootstrap] ... refusing to overwrite` fired on every `~/.claude/` watcher tick (every few seconds under active CLI use) because `linkDirectory` / `mirrorFile` logged the same obstruction on every pass. Now warns once per path via a `warnedOverwritePaths` set on `BootstrapState`; the entry clears itself when the obstruction is resolved so a later fix still re-logs once
- **TOCTOU Race in Stale-Entry Cleanup**: `removeStaleEntries` read a directory listing, then `lstat`/`unlink`ed each entry. Between the two syscalls, a concurrent CLI process could delete the same file, producing `ENOENT` error logs even though the desired end state was reached. `lstatSync` and `unlinkSync` now swallow `ENOENT` specifically; any other error still logs. The same guard landed in `linkDirectory`, `mirrorFile`, and their stat calls
- **Unhandled `rate_limit_event` SDK Message**: `@anthropic-ai/claude-agent-sdk` emits `rate_limit_event` messages carrying `SDKRateLimitInfo` (status, utilization, reset timestamp, rate-limit type). With no processor registered, the streaming manager logged `No processor for message type: rate_limit_event` for every event. New `rate-limit-processor.ts` captures the event and logs structured rate-limit info (status, type, utilization %, resets-at ISO timestamp, overage flag). Added to `SDKMessageType` union
- **Team Lead Displayed Wrong Model When Session Was Not Opus**: If the user started a team while the main session was on Haiku or Sonnet, the TeamAgentCard showed the lead running the session model instead of `claude-opus-4-7[1m]`. SDK execution was correct — the lead actually ran Opus — but the webview emit order was wrong. `TeamRunner` populated the agents Map with `spec.model ?? ''` (session model), emitted `teamStarted` with that value, then overwrote `leadAgent.model = LEAD_MODEL` afterwards. The webview had already rendered the pre-correction state. The `team-created` persistence entry was also wrong. `LEAD_MODEL` is now exported from `team-runner.ts` and applied at both construction sites: `team/index.ts:createTeam()` forces `role === 'lead' ? LEAD_MODEL` before the config is persisted, and `TeamRunner`'s Map construction applies the same invariant. The redundant downstream assignment is removed
- **SessionCache Temp-File Collision Under Concurrent Saves**: `saveIndex()` wrote to `${indexPath}.${process.pid}.tmp` and `rename`d to the final path. Two concurrent `saveIndex()` calls in the same process (same PID) collided on the temp name — the first rename consumed the temp, the second logged `ENOENT: rename ... .session-index.json.30284.tmp`. Temp name is now `${indexPath}.${pid}.${Date.now()}.${random}.tmp`, unique per call, so concurrent writes cannot stomp each other
- **`.claude.json.lock` Stale-Entry Log Spam**: The CLI creates and removes `.claude.json.lock` as a directory during its normal locking protocol. `removeStaleEntries` logged `stale entry ... is a real directory — leaving it in place` on every rescan, repeating every time the lock cycled. Same warn-once cache as the "refusing to overwrite" fix now gates this path too
- **Second `create_team` Call Bound Its TeamCard to a Failed Retry Attempt**: When a first `create_team` call hit a Zod validation rejection (e.g. model sent `claude-opus-4-7` without the `[1m]` suffix) and Claude retried, the running team started but the TeamCard was bound to the failed first tool call. The second tool call sat as a generic spinner indefinitely while the running team animated under the red error card. Root cause: `TeamService.pendingToolUseIds` was an unbounded FIFO queue. `PreToolUse` hook pushed on every `create_team` firing — including ones that would be rejected synchronously by the MCP wrapper's Zod layer before `createTeam()` ever ran. Only successful `createTeam()` invocations drained the queue, so validation-rejected IDs leaked. On retry, the successful `createTeam()` shifted the oldest (stale, failed) ID from the queue and wrote `team-correlation` under it. Fix: replace the queue with a single `pendingToolUseId: string | null` slot. Every new `PreToolUse` overwrites — a retry's tool_use_id naturally supersedes any leaked stale ID from a rejected predecessor. Single-slot semantics also match the actual usage pattern: the SDK cannot have two overlapping `create_team` calls in flight because `createTeam()` awaits team completion before returning
- **`create_team` Lead Agent No Longer Accepts A `model` Field**: The tool schema used a shared `{ name, role, model? }` object for both leads and specialists, with the handler silently dropping the lead's model (the lead always runs on Opus). The shared shape invited models to over-specify, sending `"claude-opus-4-7"` for the lead and tripping Zod's strict enum (which requires the internal `"claude-opus-4-7[1m]"` token). The whole call was rejected, forcing a retry and triggering the correlation bug above. Fix: `agents` is now a `z.discriminatedUnion('role', …)` — the lead variant has only `{ name, role: 'lead' }`, the specialist variant keeps `{ name, role: 'specialist', model? }`. The schema structurally rejects a `model` on the lead, so the model name mismatch cannot be the trigger
- **Config-Mirror Rename Aborted By Transient Windows File Lock**: `copyFileAtomic` in the auth bootstrap used `fs.renameSync(tempPath, destination)` to atomically replace mirrored config files (e.g. `~/.damocles/auth/settings.json`). On Windows, when the bundled Claude CLI sidecar had the destination open for reading — which happens every time it spawns to read user settings — `rename` raised `EPERM: operation not permitted`. The temp file was copied and stamped successfully; only the final rename failed, leaving the mirror stale and an orphan temp file for the next bootstrap sweep. Fix: new `renameWithRetryOnContention` helper retries the rename at 30 / 60 / 120 / 240 ms backoffs (max ~450 ms total) on the three transient NTFS share-lock codes (`EPERM`, `EBUSY`, `EACCES`). Other error codes (`ENOENT`, `ENOSPC`, `EROFS`, etc.) still throw immediately — we do not mask real bugs. Sync sleep uses `Atomics.wait` on a `SharedArrayBuffer` (standard Node idiom) to avoid CPU-spinning the event loop. Retries exhausting still logs the underlying error, so persistent contention remains visible

### Changed

- **`TeamService` Is Now Per-Panel**: Constructed per `ClaudeSession` with all per-panel bindings injected through a `TeamServiceDeps` interface and captured `private readonly` — never mutated. The five setters, `_teamSetupDone` guard, and `ensureTeamSetupOnce` are deleted. Stateless history reads extracted to `src/extension/team/history.ts`. `ClaudeSession.dispose()` now disposes `teamService`, so closing a panel mid-team cleanly cancels the runner
- **Concurrent Teams Across Panels**: Each panel has its own `activeRunner` mutex — two panels can run independent teams simultaneously. Flag: N concurrent teams × up to 5 agents = N × 5 concurrent Claude CLI subprocesses, multiplying API cost and memory usage

## [1.8.11] - 2026-04-18

### Added

- **Damocles-Owned Auth Surface, Isolated From Claude Code CLI**: Damocles now maintains its own OAuth grant on Anthropic's server, fully independent from the standalone Claude Code CLI. Credentials live at `~/.damocles/auth/.credentials.json`; `~/.claude/.credentials.json` is never read, written, or deleted by any Damocles code path. New module `src/extension/auth/paths.ts` is the single source of truth for `DAMOCLES_CONFIG_DIR`, `DAMOCLES_CREDENTIALS_PATH`, and `CLI_CONFIG_DIR`. `registerSignInCommand` and `registerSignOutCommand` (`src/extension/auth/login-command.ts`) spawn the bundled sidecar with `env: { CLAUDE_CONFIG_DIR: DAMOCLES_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null }` (per VS Code's `TerminalOptions.env` semantics, `null` explicitly unsets an inherited variable) and target the Damocles credentials path for every watcher / mtime probe / fallback-delete. Each command also defensively pre-creates `~/.damocles/auth/` with `0o700` so a silently-failed bootstrap can't block first sign-in. `/login` and `/logout` in either tool only affect that tool's authorization on Anthropic's server. Existing CLI users must run `Damocles: Sign In` once to mint a Damocles-specific grant — no migration, since two clients sharing one credentials file would also share one server-side grant
- **Process-Wide SDK Env Sanitization Covers All Eight Spawners**: New `sanitizeProcessEnvForSdk()` (`src/extension/auth/sdk-env.ts`) deletes the keys in `SDK_STRIPPED_ENV_KEYS` (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) from `process.env` and pins `CLAUDE_CONFIG_DIR` to the Damocles dir. Called once from `bootstrapDamoclesConfigDir()` before any SDK subprocess can spawn, so every call site — main chat, warmup, team agents (lead + specialists), recall loop, recall sub-calls, haiku orientation, BTW side-questions, memory query expansion — picks up the correct values via Node's default spawn-env inheritance with no per-site wiring. `buildEnv()` in `query-manager.ts` (which serves both the main-chat `query()` and the warmup `startup()` paths) re-applies the same strip via the shared `SDK_STRIPPED_ENV_KEYS` constant as defense-in-depth, keeping it correct even if `process.env` is remutated between activation and spawn. The `providerEnv` spread is documented as a deliberate carve-out — user-configured Bedrock / OpenRouter / Z.AI profiles legitimately re-introduce credentials by design
- **Shared `~/.claude/` Configuration Surface, Auto-Engaging**: New `bootstrapDamoclesConfigDir()` (`src/extension/auth/config-dir-bootstrap.ts`) dynamically mirrors every top-level entry of `~/.claude/` (except `.credentials.json`) into `~/.damocles/auth/`. Directories surface via `fs.symlinkSync(target, link, "junction")` on Windows (no admin / no Developer Mode required) and `"dir"` symlinks on macOS/Linux/Alpine; idempotent comparison via `fs.realpathSync` on both sides correctly handles links whose target is itself a symlink. Files are mirrored via atomic temp+rename copy with `fs.utimesSync` preserving source mtime, gated by a size+mtime diff so rescans only copy when the source actually changed. A 500 ms debounced parent-directory `fs.watch` on `~/.claude/` re-runs the rescan whenever any top-level entry is added, removed, or modified — `claude plugin add` / new slash commands / new skills / settings edits propagate without restarting Damocles. Stale entries (whose CLI counterpart no longer exists) are removed on rescan; orphan `.tmp.*` files from prior crashed copies are swept at bootstrap start. If `~/.claude/` does not exist at activation, a one-shot home-directory watch engages the full mirror as soon as the CLI is installed during the session — no VS Code restart required. Destination-type guards in both `linkDirectory` and `mirrorFile` refuse to overwrite a real directory or non-file user artifact. The bootstrap is synchronous (no misleading `async` signature) and registers a single idempotent disposer on `context.subscriptions` (guarded by a `disposed` flag) that closes both the parent-dir and home-dir watchers on `deactivate()`
- **Sign-In Banner Notes Independence**: `AuthFailureBanner.vue` adds a secondary paragraph (`authBanner.independenceNote`, translated for `en` and `el`) clarifying that signing in or out of Damocles does not affect the Claude Code CLI's authentication

## [1.8.10] - 2026-04-18

### Added

- **In-Extension Sign In / Sign Out**: `Damocles: Sign In to Claude` and `Damocles: Sign Out from Claude` command palette entries (plus `/login` and `/logout` slash commands) run the bundled Claude binary's auth flow in an integrated terminal. Eliminates the `npm install -g @anthropic-ai/claude-code` prerequisite. A chat-panel banner prompts sign-in on auth failures (missing credentials, expired OAuth, 401) and auto-refreshes active sessions after re-auth
- **SDK Bump**: `@anthropic-ai/claude-agent-sdk` updated to `0.2.113`

### Changed

- **Platform-Specific VSIX Distribution**: release workflow now produces one VSIX per Marketplace target (8 total — `win32/darwin/linux/alpine` × `x64/arm64`) on matching-OS+arch runners. Required because the SDK ships Claude Code as a per-platform native binary via optional dependencies. Each VSIX is verified to bundle the correct sidecar before upload
- **Publishing to Open VSX**: workflow publishes to `open-vsx.org` alongside the VS Marketplace (gated on `OVSX_PAT`), reaching VSCodium, Cursor, Windsurf, Gitpod, Theia. Secret setup documented in `docs/release.md`
- **README**: dropped the global `claude-code` CLI prerequisite; authentication section documents the new in-extension sign-in alongside API-key and cloud-provider options

### Fixed

- **SDK 0.2.113 Env Inheritance**: `buildEnv()` now spreads `process.env` first so the subprocess inherits `HOME`, `APPDATA`, `USERPROFILE`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_PROFILE`, etc. SDK 0.2.113 reverted 0.2.111's overlay semantics — without this, authentication and filesystem-aware tools failed silently
- **Opus 4.7 Silently Capped to 200K After Any Session Reset**: Stats footer showed `/ 1.0M` while the API call was actually limited to 200K. Root cause: the SDK's `supportedModels()` returns Opus 4.7 keyed as `"claude-opus-4-7[1m]"` (with the `[1m]` suffix baked into the value), not `"claude-opus-4-7"`. The auto-fetch in `postQueryCreated` overwrote `this.cachedModels` with that list, so every subsequent `getModelInfo("claude-opus-4-7")` returned `undefined`. `buildQueryOptions` then evaluated `alwaysOneM = false` and sent the bare `claude-opus-4-7` model id to the CLI, which Anthropic enforces at 200K. Any `closeAndReset` path — plan-mode "Clear Context & Accept", model switch, MCP/provider/plugin/chrome/fast-mode toggle — triggered the regression. The webview denominator stayed at 1M because `ModelManager.sendModelForPanel` derives it from `DEFAULT_MODELS` directly, producing the visible discrepancy. Fix: `getModelInfo` now falls back to `DEFAULT_MODELS` when the SDK-sourced cache has no entry for the configured value, so local-only flags (`alwaysUses1mContext`, `supports1MContext`, `supportsAdaptiveThinking`, `supportedEffortLevels`) survive any SDK schema drift. Same spread-merge `getSupportedModels()` already uses (32fc1d8) was also applied to the auto-fetch path for consistency. Permanent `[QueryManager.buildQueryOptions] … → cliModel=…` diagnostic log retained

### Removed

- **Intel-Mac (`darwin-x64`) VSIX**: release matrix no longer builds for Intel Macs. Apple stopped selling Intel hardware in 2023, the cohort is small and shrinking, and the `macos-13` runner pool is the primary release-pipeline bottleneck (10–60 min queue times vs. seconds on other matrix legs). Apple Silicon (`darwin-arm64`) remains supported. Intel-Mac users installing from the Marketplace will see no compatible version — Intel hardware cannot execute arm64 binaries (Rosetta 2 translates x64 → arm64, not the reverse), so there is no useful fallback

## [1.8.9] - 2026-04-17

### Fixed

- **Opus 4.5 / Haiku 4.5 Ignored `Disable Thinking`**: `buildThinkingOptions` consulted `thinkingDisabled` only inside the adaptive branch, and `SettingsPanel.vue` gated the switch behind `isAdaptiveCapable`, making the flag unreachable for legacy models. Omitting the `thinking` block also failed — the SDK applies a default that enables extended thinking on Haiku 4.5 when no config is sent. Fix: `thinkingDisabled` is now checked first in `buildThinkingOptions` and returns `{ thinking: { type: 'disabled' } }` universally (valid for all models per SDK `ThinkingConfig`); `disableThinkingForNextQuery` (`/btw`) sends the same signal without model-capability branching. Diagnostic `[Thinking]` logs retained at builder, each branch, resolved-query site, and override site
- **Context-Window Denominator Reverted to 200K After Clear-Context on Opus 4.7**: Session Stats flipped `1.0M → 200.0K` after the first post-clear turn. `result-processor.ts` picked `Object.values(modelUsage)[0]?.contextWindow`, which was the first-inserted Haiku entry from a side query rather than the primary `claude-opus-4-7[1m]`. Fixed at the trust boundary rather than the picker: removed `ResultMessage.context_window_size` carry-through (producer in `result-processor.ts`, consumer in `streaming-handlers.ts`), dropped `CheckpointTracker.setContextWindowSize` from the streaming-manager interface, and routed every `contextUsage` / `contextUsageSummary` emit through `ClaudeSession.normalizeContextUsage(data)` which overrides SDK-reported values with `getContextWindowForModel(modelId, betas)`

### Changed

- **Thinking Settings UI — Single Source of Truth**: `SettingsPanel.vue` now renders one `Disable Thinking` switch plus a depth control shown only when not disabled (effort dropdown for adaptive, token-budget input for legacy). Removed the redundant `Extended Thinking` toggle (which used `maxThinkingTokens = null` as an implicit disable signal) along with the dead `enableExtendedThinking` computed and `lastThinkingTokens` ref
- **`damocles.maxThinkingTokens` Is Depth-Only**: No longer doubles as an on/off. Legacy models always receive `{ type: 'enabled', budgetTokens: N }` when thinking is enabled, falling back to `DEFAULT_THINKING_TOKENS` (63999) when null. `damocles.thinkingDisabled` is the sole on/off signal. Descriptions updated in `package.nls.json` / `package.nls.el.json`
- **`ContextMonitor` Requires Authoritative Window Size**: Constructor and `reset()` now take `contextWindowSize`, eliminating the transient 200k default that previously occupied `state.contextWindowSize` between construction and first authoritative write. New `ClaudeSession.resolveContextWindowSize()` helper centralizes `getContextWindowForModel(...) ?? DEFAULT_CONTEXT_WINDOW` across the four authoritative sites (constructor, `reset`, `setModel`, `setBetas`)
- **`ClaudeSession.normalizeContextUsage` Throws on Missing Model**: Previously fell back to `data.maxTokens` (untrusted SDK value) when `currentModelId` was null. Now throws — the single trust-boundary enforcement point, so future `ContextUsageData` fields are explicitly forced to decide whether to override
- **Removed Dead `contextWindowSize?` Parameter**: Dropped from `ContextMonitor.updateTokenUsage` and `CheckpointTracker.updateTokenUsage`. No caller passed it, and keeping it left a second-channel write path for untrusted SDK values

## [1.8.8] - 2026-04-17

### Added

- **Compass Compound Edge Indexes (schema v2)**: `idx_edges_target_kind(target, kind)`, `idx_edges_source_kind(source, kind)`, and `idx_edges_composite(kind, source, target)` added to `edges`. Every `getEdgesByTarget(...).filter(kind === X)` site (flows, changes, communities, architecture overview) now runs an index scan; the 3-column composite matches the upsert-dedup lookup exactly. Idempotent, transactional v1 → v2 migration in `migrations.ts` — fresh DBs jump directly to `CURRENT_SCHEMA_VERSION` via `SCHEMA_SQL` without re-running per-version index blocks; no data transforms
- **Compass Adaptive, Deterministic Louvain**: Resolution scales inversely with graph size via `max(0.05, 1/log10(max(order, 10)))` — small graphs (`order ≤ 10`) keep `1.0` unchanged; large graphs yield coarser, more-meaningful communities (fixes thousand-cluster noise on 30k-node repos). Partitioning seeds `graphology-communities-louvain` with a mulberry32 PRNG keyed on a FNV-1a hash of sorted qualified names, eliminating run-to-run community-ID churn from the library's internal `Math.random` random walk
- **Compass Directory-Based Community Fallback**: `detectFileBased` → `detectDirectoryBased` — strips longest common directory prefix, groups by adaptive directory depth (deepens until `MIN_QUALIFYING_DIRECTORY_GROUPS` (10) reached or path exhausted). Flat-directory cases fall back to file stems. Replaces one-community-per-file output for workspaces above `MAX_LOUVAIN_NODES` (20k) or when Louvain is unavailable
- **Compass Criticality-Weighted Risk Score**: `computeRiskScore` flow contribution replaced from `min(count × 0.05, 0.25)` with `min(sum(criticalities), 0.25)`. Auth/payment flow membership now outweighs utility flow membership. Score, factors, and test-coverage are computed in a single `analyzeNodeRisk` pass — no redundant `getEdgesByTarget`/`countFlowMemberships` re-queries per changed node. New `GraphStore.getFlowCriticalitiesForNode` (parameterized, joined on `idx_flow_memberships_node`)
- **Compass Expanded Framework Decorator Patterns**: `FRAMEWORK_DECORATOR_PATTERNS` grown from 7 to 25 — Spring `@GetMapping`/bare `@RequestMapping`, NestJS/Angular `@Controller`/`@Injectable`, Django `@receiver`/`@api_view`, Express/Koa/Hono `app.use`/`app.all`, AI-agent `@tool`/`@tool_plain`, SQLAlchemy `@listens_for`, Alembic migrations, task queues, middleware, GraphQL resolvers, Android/Compose lifecycle. All patterns anchored at start (`^@?...\b`) so names like `MyModule`, `UserReceiver`, `formatReceiverData` do not false-positive as framework decorators
- **Compass Expanded Entry-Name Patterns**: `ENTRY_NAME_PATTERNS` grown from 9 to 25 — AWS Lambda `lambda_handler`, Alembic `upgrade`/`downgrade`, FastAPI `lifespan`, Servlet `doGet`/`doPost`, Python `BaseHTTPRequestHandler` `do_GET`/`do_POST`, Android `onCreate`/`onStart`, Angular `ngOnInit`/`canActivate`, React `componentDidMount`/`render`. All case-sensitive (preserves `^Test[A-Z]` and camelCase conventions)
- **Compass Entry-Point Test-File Exclusion**: `detectEntryPoints` and `traceFlows` gain `{ includeTests?: boolean }` option (default `false`). Exclusion uses the canonical `isTestFile` (`extractors/lang-maps.ts`) — covers `__tests__/`, `tests?/`, `*.spec.{j,t}sx?`, `*.test.{j,t}sx?`, `test_*.py`, `*_test.py`, `*_test.go`, `*Test.{kt,java}`, plus nodes flagged `is_test === 1`. Flow analysis now focuses on production entry points by default

- **Compass PHP PSR-4 Namespace Resolution**: PHP `use App\Models\Camera` style imports now resolve to the target workspace file node during `resolveExternalEdges`. `resolveImportSpecToFiles` normalizes both dots and backslashes in namespace separators (`replace(/[.\\]/g, '/')`) so that suffix-match against forward-slash file paths succeeds. New `ComposerPsr4Resolver` (`composer-resolver.ts`) discovers the nearest `composer.json` for each PHP source file and consults `autoload.psr-4` / `autoload-dev.psr-4` mappings with longest-prefix match, so projects whose directory layout diverges from the Laravel default (e.g., `"App\\Foo\\": "src/foo/"`) resolve correctly. Wired into the alias-resolver chain after tsconfig/vite resolvers. PHP `namespace_use_clause` extraction strips `namespace_aliasing_clause` children so that `use Foo\Bar as Baz;` emits `Foo\Bar` (not `Foo\Bar as Baz`) as the import target. `PHP_EXTERNAL_PATTERNS` extended with `Google\`, `Aws\`, `Stripe\`, `Sentry\`, `Stevebauman\`, `Webpatser\` to classify additional common Composer vendors as external

- **Compass Dynamic `import()` Extraction**: JS/TS/TSX dynamic imports (`import("./foo.vue")`) now emit `IMPORTS_FROM` edges targeting the string argument. Detected in two sites that cover every call context: `extractFromTree` (top-level and expressions inside unregistered arrow bodies — e.g., Vue router `{ component: () => import("./Foo.vue") }` object-literal properties) and `walkCalls` (inside registered function bodies and variable-declarator arrow bodies). Edge source is always `ctx.fileQualified`, not the enclosing function. Template-string arguments (`import(\`./\${name}.vue\`)`) are skipped. Fixes orphan File nodes for SPA components lazy-loaded via router `component: () => import(...)` patterns

- **Compass C# `using` Directive Extraction**: `getImportTarget` for csharp no longer relies on `childForFieldName('name')` (the grammar exposes no `name` field on `using_directive`). Falls back to iterating `namedChildren` for the first `qualified_name` or `identifier`, so `using System.Collections.Generic;` emits `System.Collections.Generic` and `using Serilog;` emits `Serilog`. Previously every C# file produced zero import edges, leaving `Program.cs` and all other `.cs` files as orphan File nodes despite having `using` directives. Works identically for class-scoped files and top-level-statement `Program.cs` (modern minimal-hosting ASP.NET)

### Changed

- **Compass Architecture Overview Ignores TESTED_BY**: `getArchitectureOverview` skips `TESTED_BY` edges before counting cross-community edges. Test↔production coupling (always cross-module by nature) no longer masks genuine architectural smells. Return shape unchanged
- **Compass Sensitive-File Filter Scope Tightened**: `isSensitive` (`detect.ts`) no longer applies the substring-name regex (`credential|secret|passwd|password|private_key`) to source code — legitimate components like `PasswordInput.vue`, `PasswordForm.vue`, `UpdatePasswordController.php`, `credentialProvider.ts`, `SecretManager.java` are now indexed instead of being skipped during file collection. Substring-name patterns apply only to data/config extensions (`.env`, `.ini`, `.conf`, `.json`, `.yaml`, `.toml`, `.txt`, `.csv`, etc.); strict full-filename patterns (`.env*`, `.pem`, `.key`, `id_rsa`, `.netrc`) still block real credential artifacts universally
- **Compass Expected-Orphan Classifier**: `EXPECTED_PATTERNS` in the validation handler gains `\.d\.ts$` — TypeScript ambient declaration files (`*.d.ts`) are classified as expected orphans (info-level) rather than warnings. Matches TypeScript's convention that `.d.ts` files contain only type declarations and by design have no extractable runtime entities

## [1.8.7] - 2026-04-17

### Added

- **Compass Cooperative Worker Scheduler**: Two-queue (light/heavy) scheduler replaces FIFO chain in `compass-worker.ts`. Light reads preempt in-flight heavy builds at `scheduler.yield()` checkpoints every `Math.max(25, total/100)` files plus phase boundaries. sql.js atomicity preserved — dispatch bodies never interleave. FIFO within each priority class
- **Compass Build Progress Events**: `WorkerProgressEvent` flows worker → `CompassService.onProgress(cb)` → `compassBuildProgress` webview message. Validation and Graph panels render `Building X / Y files…` during in-flight builds. Cleared only on status `'ready'`
- **Per-Message-Type Timeouts**: `TIMEOUTS_BY_TYPE` lookup replaces single 30s default. `webviewValidation: 180_000`, `webviewGraph/BlastRadius: 60_000`, others 30s. `_sendRequest` resolves via `timeoutMs ?? TIMEOUTS_BY_TYPE[type] ?? TIMEOUTS.query`
- **`mapWithConcurrency` Utility**: Order-preserving bounded-concurrency map in `src/extension/compass/util.ts` (17 LOC). Caps `fs.access` at 64 in validation to relieve libuv thread-pool contention on slow filesystems
- **Compass `getEdgesAmong` Parity Test + Bench**: 6-test parity fixture locks temp-table path ≡ IN path on edge-ID set equality. `__tests__/bench/getEdgesAmong.bench.ts` runnable via `npx tsx` on 18k/70k synthetic fixture

### Changed

- **Compass Validation Deferred Serialize**: `handleWebviewValidation` commits stale-file cleanup inline and returns immediately; `store.serialize()` is enqueued via the scheduler's light queue. Guaranteed to complete before the next heavy op. Crash recovery via next `fullBuild`'s stale-file re-detection
- **Compass `getEdgesAmong` Temp-Table Path**: Query sets ≥ 250 qualified names join against a `TEMP TABLE _qn_filter`; smaller sets stay on `IN (...)`. p50 193.0 → 183.5 ms, p99 212.4 → 201.0 ms on 18k/70k fixture. Gate-justified — shipped only because measured p50 exceeded the 100ms threshold
- **Compass Validation `fs.access` Concurrency**: Unbounded `Promise.all` swapped for `mapWithConcurrency(files, 64, ...)`. Identical stale-file set byte-for-byte
- **Compass Webview Request Idempotence**: `CompassValidationPanel.vue` / `CompassGraph.vue` `onMounted` hooks guard with `!loading && !result`. Pinia sets `loading=true` synchronously before `postMessage`. Re-validate/Refresh buttons stay unconditional

### Fixed

- **Compass Webview Timeouts on Large Builds (≥ 1k Files)**: Opening Validation or Graph panel during a build produced `Compass worker request timeout (webview:*, 30000ms)` spam. Root causes — strict FIFO, single 30s timeout, webview re-firing on every `onMounted` — all fixed at root by the cooperative scheduler + `TIMEOUTS_BY_TYPE` + idempotence guard
- **Compass `incrementalUpdate` Re-entrancy Fake Return**: `handleIncrementalUpdate` previously set `isRebuildInProgress`, returned `'indexing'` to re-entrant callers as if successful, then replayed with `id: -1` (response dropped). Deleted — function is now straight-line; the `heavyQueue` FIFOs re-entrant rebuilds honestly. Burst coalescing remains the 500ms watcher debounce's job

## [1.8.6] - 2026-04-17

### Changed

- **System Prompt v2.1.112 Alignment**: `buildSystemPrompt` refreshed toward upstream — new Anthropic identity line, exploratory-question and comment-policy bullets, condensed Tool Usage around `TaskCreate`/`TaskUpdate`, `# Communication style` → `# Text output`, file-vs-edit judgment bullet
- **Opus 4.7 Subagent Guidance**: New bullet nudges Opus 4.7 to stop under-spawning subagents and to fan out in parallel when tasks are independent
- **Compass Prompt Reframed**: `**Mandatory first step:**` → `**Fast-path for code targeting:**`. `COMPASS_AGENT_PROMPT` softens `your first tool call must be Compass` → `start with Compass`. Plan-mode trigger preserved
- **Team Prompt Positive-Voice Pass**: Lead and specialist prompts convert non-safety negatives to positive voice. Safety-critical negatives (PLAN mode, REPL, `Never poll`, `compass_build` prohibition, Quality Standards) kept verbatim
- **Memory Prompt Polish**: Recording-observations guidance consolidated into a single positive-voice sentence
- **Compass Extraction-Format Version**: Split `schema_version` into `schema_version` (DDL; v1) and `extraction_format_version` (extractor output; v1). Legacy users at `schema_version=2` (prior overloaded bump) treated as `extraction_format_version=1` so the wipe doesn't run twice
- **SDK Bump**: `@anthropic-ai/claude-agent-sdk` updated to `0.2.112`
- **1M Context Window Section Gating**: "Extended Features" settings section renders only for `supports1MContext: true` models (Opus 4.6). Redundant disabled-state guard and `text-muted-foreground` class inside the `v-if` removed
- **i18n**: `context1mDescription` (en, el) simplified; orphaned `extendedThinkingCondition` key removed

### Added

- **Prompt Snapshot Tests**: 4 vitest files, 52 tests, 9 snapshots across system/compass/team/memory prompts — locks text against silent drift
- **Cross-File Regression Tests**: `cross-file-calls.test.ts` (16 tests) + 5 fixtures — dangling-edge emission, import-scoped resolution, global-unambiguous fallback, ambiguous-drop, barrel re-export, anonymous-arrow/IIFE/callback attribution, end-to-end `callers_of` / `referencers_of`
- **Ruby Nested-Class Parser Tests**: 3 tests locking `module Networking { class ApiClient }` parent-chain qualification and CONTAINS edges
- **Externals Classifier Tests**: `known-externals.test.ts` (8 tests) — Rust stdlib, Ruby/npm sub-paths, scoped packages, Node `fs/promises`, PHP PascalCase exclusion
- **Compass Diagnostic Script**: `scripts/test-compass-crossfile.js <workspace> <symbol>` reports schema version, matching nodes, and incoming CALLS/REFERENCES from the DB without reloading the extension host

### Fixed

- **Compass Import Resolver Hijacked Bare Modules to Local Files**: `resolveImportSpecToFiles` suffix-match let workspace files like `src/react.ts` silently hijack bare imports (`react`, `vscode`), contaminating both import-edge rewrites and `fileImports` cross-file resolution. Gated by `isKnownExternal(trimmed)` for non-relative specs
- **Compass Alias Resolvers Could Escape Workspace Root**: `ViteAliasResolver` / `TsconfigResolver` probed `resolve(__dirname, '../../../../etc')` without bounds-checking. Both now accept `workspaceRoot` via constructor and drop probed paths outside it. Threaded from `fullBuild` / `incrementalUpdate` → `resolveExternalEdges` → resolvers
- **Compass CommonJS `module.exports` Files Extracted No Entities**: JS walker recognized only ES-style declarations, leaving `module.exports = {...}` / `module.exports.<name>` / `exports.<name>` files (e.g. `worker-vscode-shim.js`) as orphaned `File` nodes. New `handleJsCjsExport` in `walker.ts` dispatches arrow/function-expression values to `Function`, classes to `Class`, nested objects to `Type` (namespace), with chained `parentName`. Real shim now extracts 5 nodes. 6 new parser tests + `sample_cjs.js` fixture
- **Compass Ruby/Python Nested-Class Orphaned Methods**: `handleClass` dropped the parent chain on recursion, producing wrong qualified names for methods inside `module A { class B }`. Now propagates the full chain. Applies to Ruby, Python, Scala, C#, Kotlin, C++
- **Compass Validation Counted Test-Fixture Imports as Warnings**: Unresolved-references metric mixed actionable prod imports with intentionally-dangling test fixture imports (dominated the count). New `isTestFixtureFile()` filter in `database.ts` matches `__tests__/fixtures/`, `__fixtures__/`, etc. and excludes them from unresolved-refs
- **Compass Externals Classifier Missed Bundler Assets**: Vite/webpack imports like `./style.css`, `./locales/en.json`, `../assets/x.svg?raw` flagged as unresolved refs. New `ASSET_EXTENSIONS` + `isAssetImport()` with query-string stripping
- **Compass Externals Classifier Missed Rust stdlib & npm Sub-paths**: `std::`/`core::`/`alloc::` paths and `identifier/sub/path` specs (`net/http`, `vitest/config`) miscategorized. New `RUST_STDLIB_PREFIXES` + refined `isBareModuleSpec` for lowercase identifier sub-paths (excluding PHP PascalCase)
- **Compass Cross-File `callers_of` / `references_of` Silent "none"**: Call-graph pass was file-scoped, silently dropping cross-file callees. Extractors now emit dangling bare-name `CALLS`/`REFERENCES`; `cleanEdges` keeps them; `resolveExternalEdges` adds import-scoped pass (resolves against source's `IMPORTS_FROM` targets) before global-unambiguous fallback. Unresolved edges deleted in-transaction
- **Compass Anonymous Arrow / IIFE Call Attribution**: `walkCalls`/`walkReferences` unconditionally stopped at `arrow_function`/`function_expression` — correct for named arrows, wrong for anonymous IIFEs / `.map` callbacks / object-literal values. Now boundaries only when the wrapper is registered (via new `registeredArrowWrappers` tagging), so anonymous bodies contribute to the enclosing extracted function
- **Compass `compass_stats` Timezone Display**: `Last Updated` dumped raw UTC ISO-8601; now renders `YYYY-MM-DD HH:MM:SS (UTC±HH:MM)` in host local timezone via `formatLocalTimestamp()`
- **Compass Internal IMPORTS_FROM Never Resolved to File Nodes**: Import edges left as literal path strings (`./types`, `../logger`), flagged as unresolved refs and blocking `importers_of` traversal. `resolveExternalEdges` now has a dedicated first pass that rewrites unambiguous specs to the resolved File node's qualified name
- **Compass Externals Classifier Missed Node Builtins & Bare Module Specs**: `fs`, `node:*`, `vscode`, bare npm packages miscategorized as unresolved refs. Added Node builtins set (incl. `fs/promises`, `timers/promises`), `node:*` prefix, editor externals, and `isBareModuleSpec()` heuristic
- **Compass TsconfigResolver / Vite Alias Resolution Unwired**: `TsconfigResolver` was tested but never called from `resolveExternalEdges`; Vite `@/*` had no resolver at all. Hundreds of webview imports stayed as unresolved string literals. New `ViteAliasResolver` (parses `resolve(__dirname, ...)` and `fileURLToPath(new URL(...))`), combined with `TsconfigResolver` via an `AliasResolver` facade, wired into `resolveImportSpecToFiles()` as a first-pass attempt. 6 tests

## [1.8.5] - 2026-04-16

### Added

- **Claude Opus 4.7**: New default model with adaptive thinking and 1M context window always on (`[1m]` suffix appended automatically via the `alwaysUses1mContext` model capability flag — no beta toggle)
- **`xhigh` Effort Level**: New reasoning effort between `high` and `max`, recommended for Opus 4.7 coding/agentic work. Passed through to the SDK unchanged
- **`auto` Permission Mode**: Model classifier approves/denies tool permissions. Cycles default → acceptEdits → auto → plan when the active model supports it (Opus 4.7/4.6, Sonnet 4.6). Hidden from dropdown and Shift+Tab cycle when unsupported. Team permission mode now preserves `auto` instead of silently downgrading to `default`
- **Per-Model Effort Persistence (`damocles.effortByModel`)**: Effort is stored per model id so switching models never sends an unsupported value to the SDK. On activation, any legacy `damocles.effort` is migrated one-shot into the map and the legacy key is removed. Write-side validates against `supportedEffortLevels`
- **Subprocess Warmup at Panel Open**: Adopts SDK 0.2.111's `startup()` / `WarmQuery` API (`QueryWarmupManager` in `src/extension/claude-session/query-warmup.ts`). The CLI subprocess spawns eagerly when a panel opens so the first message streams without cold-start delay. Race-safe — if the user sends before warmup finishes, the send path awaits the in-flight promise once and consumes the warm. A `WarmupInputs` fingerprint (model, MCP names, provider env, plugins, chromeEnabled, sandbox, thinking, debug, budget, file-checkpointing, progress summaries, maxTurns) disposes and rebuilds the warm whenever any fingerprint key changes. A workspace-config listener invalidates on setting edits, coalesced via `queueMicrotask` so rapid synchronous setters (e.g., `setModel` + `setBetas`) produce a single spawn. Skipped for recall mode and for resumes with a mid-turn checkpoint
- **Thinking Display**: Adaptive thinking always sends `display: 'summarized'` so thinking blocks remain visible (overrides Opus 4.7's default of `omitted`)

### Changed

- **1M Context Detection**: Replaces hardcoded `configuredModel === "claude-opus-4-7"` branch with a `ModelInfo.alwaysUses1mContext` capability flag — same mechanism as `supports1MContext`
- **Default Fallback Model**: `claude-opus-4-7` consolidated into a single `DEFAULT_FALLBACK_MODEL` constant in `shared/types/constants.ts` (consumed by `ModelManager`, `QueryManager.buildQueryOptions`, `session/writing.ts`). Team lead and `TEAM_ALLOWED_MODELS` updated to Opus 4.7
- **Effort Validation**: Resolved effort is validated against the active model's `supportedEffortLevels` at both write and read. Double-validation in `QueryManager.buildQueryOptions` removed — single source of truth in `resolveEffortForModel`
- **Sonnet 4.6**: `max` effort level added (bug fix — was missing from `supportedEffortLevels`). `auto` permission mode supported
- **Opus 4.6**: `auto` permission mode supported
- **`initializeEarly` Resume**: Pre-warms the resumed query with the pending `resumeSessionAt` so the checkpoint is not silently dropped when a later `sendMessage` short-circuits on the existing-controller guard
- **Session Dispose Safety**: `QueryManager.dispose()` sets a `_disposed` flag and tears down warmup. `invalidateWarmup()` skips rearm after disposal so late config-change events can't revive a torn-down session
- **SDK `env` Overlay**: Drops the redundant `...process.env` spread — SDK 0.2.111 overlays `process.env` automatically. `buildEnv()` now returns only Damocles's deliberate overrides (`PATH`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, and optional `providerEnv`)
- **1M Context Description (i18n)**: `context1mDescription` (en, el) now reads "Extended context for Opus 4.6 (Opus 4.7 always uses 1M)" — Sonnet 4.6 does not support 1M context, so the label no longer mentions it
- **Model Family**: System prompt references "Claude 4.7 and 4.6". Fast-mode description uses the active model's display name dynamically
- **SDK Bump**: `@anthropic-ai/claude-agent-sdk` updated to `0.2.111`

### Removed

- **Legacy `damocles.effort`**: Superseded by `damocles.effortByModel`. Existing values are migrated on activation, then the key is cleared

## [1.8.4] - 2026-04-15

### Changed

- **MCP Tool Reduction**: Removed 10 MCP tool registrations that were never genuinely invoked — 7 Compass tools (`compass_detect_changes`, `compass_list_flows`, `compass_get_flow`, `compass_list_communities`, `compass_get_community`, `compass_architecture`, `compass_postprocess`) and 3 Memory tools (`get_timeline`, `pin_memory`, `unpin_memory`). Saves ~3,000–6,000 schema tokens per session permanently
- **`compass_review_context` Auto-Detection**: `changed_files` parameter is now optional — when omitted, changed files are auto-detected via git (same logic as the removed `compass_detect_changes` tool)
- **SDK Bump**: `@anthropic-ai/claude-agent-sdk` updated to `0.2.109`

## [1.8.3] - 2026-04-14

### Changed

- **Compass Plan Mode Injection**: `PostToolUse` hook for `EnterPlanMode` now returns dynamic Compass status as `additionalContext`, reinforcing Compass-first behavior immediately when plan mode activates
- **Compass Subagent Init Injection**: `SubagentStart` hook injects dynamic Compass context (node/edge counts, staleness) before the subagent's first tool call — complements the existing `UserPromptSubmit` hook that provides static usage instructions
- **Compass System Prompt Strengthened**: Emphasizes token efficiency ("replaces 3-5 rounds of Glob/Grep") and explicitly applies in all modes including plan mode
- **Compass Agent Prompt Tightened**: Skip clause now requires specific file paths and line numbers from a prior Compass call, not just any entity/file mention

## [1.8.2] - 2026-04-14

### Changed

- **Compass `alwaysLoad`**: `compass_search` and `compass_query` marked `alwaysLoad: true` — SDK loads their schemas upfront, eliminating the ToolSearch roundtrip that made Glob/Grep structurally cheaper
- **Compass Prompt Repositioned**: Moved from end-of-prompt append to inline after "Using your tools" section in the main system prompt. Removed redundant 14-tool reference table (schemas discovered via MCP). Session guidance search lines omitted when Compass is enabled to avoid contradiction
- **Per-Turn Behavioral Injection**: `getCompassContext()` now returns behavioral instructions alongside metadata XML — ready state reinforces "use compass_search before Glob/Grep", stale state warns to verify results
- **Subagent Compass Hooks**: Main compass hook skips subagents; new hook injects `COMPASS_AGENT_PROMPT` for SDK preset subagents (Explore, Plan, general-purpose) so they use Compass instead of falling back to Glob/Grep

### Fixed

- **Message list gap inconsistency during streaming**: Three root causes fixed — (1) `LEVEL_GAPS` off-by-one in `getGap` formula gave 16px gaps between all content items instead of the intended 12px (`space-y-3`), (2) thinking-block emission condition used `msg.isPartial` but ThinkingIndicator only renders for `msg.isThinkingPhase`, creating 0-height ghost items that contributed 28px of invisible gap space, (3) frame builder and reflow now skip 0-height items in gap calculation
- **Height estimate accuracy**: Replaced static `HEIGHT_ESTIMATES` lookup with context-aware estimators — `estimateToolCallHeight` derives from card structure (header + content + result state), `estimateThinkingHeight` checks streaming vs collapsed state, text fallback raised from 22px to 36px to match MarkdownRenderer minimum

## [1.8.1] - 2026-04-14

### Added

- **Compass Worker Thread**: All graph operations (tree-sitter parsing, SQLite, Louvain, flow tracing) moved to a `worker_threads` worker with ID-based request/response multiplexing, per-request timeouts, and crash recovery. Promise-chain serialization queue prevents concurrent mutation
- **No-Folder Guard**: Compass skips init when no workspace folder is open — prevents indexing `homeDir` and freezing VS Code
- **PHP Enum & Trait Extraction**: Enums (pure and backed) and traits extracted as Class nodes with heritage edges
- **TS Barrel Re-export Extraction**: `export { Foo } from './module'` emits `IMPORTS_FROM` edges
- **Known Externals Filtering**: 30+ PHP framework namespaces, 60+ PHP built-ins, 90+ TS built-ins filtered from unresolved reference warnings

### Changed

- **MCP Handler Extraction**: 14 `handle*` functions moved to `mcp-handlers.ts` — handlers run in-worker, MCP server stays on main thread
- **Build/Postprocess Persistence**: `mcp:build` and `mcp:postprocess` now serialize to disk after completion
- Unresolved edges validation query bounded to `LIMIT 5000`
- `getLanguageFamily()` handles `.cc`, `.cxx`, `.kts`
- `.blade.php` excluded from `collectFiles()`
- `LEVEL_GAPS` off-by-one fixed — index 0 was dead code, index ≥ 3 produced NaN

### Fixed

- Worker crash double-fire: `_onWorkerError`/`_onWorkerExit` guarded against re-entry
- Worker logs forwarded via `parentPort.postMessage` instead of swallowed by no-op shim
- Async `CompassService.dispose()` rejection caught in sync `ChatPanelProvider.dispose()`
- Cross-platform: `isKnownExternal` and orphan classification patterns match backslash paths
- Duplicate `fileCount`/`filesCount` fields consolidated to `fileCount`

## [1.8.0] - 2026-04-13

### Added

- **Virtualized Message List**: Replaced `MessageList.vue` with `VirtualizedMessageList.vue` — a true mount/unmount virtualizer that only renders visible messages in the DOM. Uses `@chenglou/pretext` for canvas-based text height measurement without DOM reflow. Binary search visible range (O(log n) per scroll frame), RAF-scheduled rendering, 5-item overscan above and below viewport. Scales to 10,000+ messages without performance degradation. Typically 15-25 DOM nodes regardless of conversation length

- **Pretext Measurement Layer**: New `usePretextMeasurement.ts` composable wraps pretext's `prepare()`/`layout()` API. `prepare()` segments text and measures word widths via canvas (cached by content string, width-independent). `layout()` computes line count and height via pure arithmetic (~0.0002ms per text block). Font initialization awaits `document.fonts.ready` and reads VS Code CSS variables (`--vscode-editor-font-family`, `--vscode-editor-font-size`)

- **Message Flattening**: New `useVirtualizedMessages.ts` composable flattens grouped `ChatMessage[]` into individual `VirtualItem[]` — each text block, tool call, thinking indicator, compact marker, error, streaming text, and background label becomes an independently virtualizable item with type discriminator and source message reference

- **Scroll Engine**: New `useScrollEngine.ts` composable implements the core virtualization: frame building (cumulative position sum), binary search visible range with occlusion support, ResizeObserver-based height correction for complex components, scroll anchor correction (adjusts `scrollTop` when above-viewport items change height), and RAF-scheduled rendering

- **Fixed Sticky User Header**: New `StickyUserHeader.vue` replaces the per-message IntersectionObserver approach. Single `position: sticky` element whose content is computed from scroll position — no observer, no state oscillation. Expand/collapse toggled ONLY on click (max 30vh expanded). Includes gradient fade, image count badge, and scroll-to-original button

- **Component Extraction**: `UserMessageBlock.vue` (full user message content), `ToolCallRouter.vue` (tool-call if/else-if routing chain), `VirtualItemWrapper.vue` (per-item absolute-positioned wrapper with type routing, ResizeObserver, and entrance animation gating) extracted from the monolithic MessageList for independent virtualization

### Changed

- **Auto-Scroll**: `useAutoScroll.ts` now observes DOM mutations including `style` attribute changes (canvas height updates from the virtualizer) instead of only `childList`/`characterData`/`subtree`. Same RAF-batched scroll-to-bottom with `wasAtBottom` user-scroll detection

### Removed

- **MessageList.vue**: Replaced by `VirtualizedMessageList.vue`
- **useStickyMessages.ts**: Replaced by `useStickyHeader.ts`. IntersectionObserver-based sticky detection replaced with position-computed approach

## [1.7.7] - 2026-04-13

### Added

- **Sticky User Message Headers**: When a user message scrolls past the viewport top, it collapses into a compact sticky header showing truncated content with expand/collapse and scroll-to-original controls. New `useStickyMessages` composable uses IntersectionObserver with a separate sentinel element to detect stuck state without scroll-position oscillation. Messages grouped into user+response pairs via `messageGroups` computed. `overflow-anchor: none` on the message container prevents browser scroll anchoring from fighting the height changes. `scroll-margin-top: 4px` on sentinels avoids flicker at the stuck/unstuck threshold boundary

- **Session History Popover**: Session picker moved from an inline dropdown below the header to a Popover button in the header bar. `defineExpose({ isInEditMode })` lets the parent guard Escape from closing the popover during rename/tag/delete operations. `CSS.escape()` on `data-session-id` selector prevents injection from malformed session IDs

### Changed

- **Status Bar Indicators**: McpStatusIndicator and PluginStatusIndicator simplified from labeled badges to icon-only buttons (`IconMcp`, `IconPuzzle`) with status-colored text. Removed unused `Component` type imports and intermediate state properties (`icon`, `text`, `count`)

- **Auto-Scroll Optimization**: `handleMutation` in `useAutoScroll` now early-returns when `wasAtBottom` is false (skips rAF scheduling entirely) and batches via `requestAnimationFrame` with re-check inside the callback to avoid racing with user scroll events

- **Scrollbar Styling**: Message container hides scrollbars (`scrollbar-width: none`). Global `scrollbar-width: thin` moved from `*` to `html` (inherits identically, more conventional). Webkit scrollbar thumb refined with border-radius, subtle border, and hover/active states. Separate styles for `pre`/`code` scrollbar thumbs

- **User Message Visual Style**: User messages use full-width flat borders (`border-y -mx-4`) instead of rounded cards (`rounded-xl ring-1`) to support the sticky header transition seamlessly

### Fixed

- **Stale Sticky IDs After Rewind**: `registerSentinel(id, null)` now clears the message ID from `stuckMessageIds`, preventing garbage accumulation in long sessions with rewinds or compactions

- **Hardcoded English in Sticky Header**: Image count string (`"1 image"` / `"2 images"`) replaced with `t('stickyMessage.imageCount')` using vue-i18n plural syntax. Keys added to both `en.json` and `el.json`

- **Escape Handler Type**: `handleSessionPopoverEscape` parameter narrowed from `Event` to `KeyboardEvent` to match reka-ui's `@escape-key-down` emit type

## [1.7.6] - 2026-04-12

### Fixed

- **Compass Popover Stays Open After Panel Button Click**: Clicking Graph, Search, or Validate in the CompassIndicator popover opened the overlay panel but left the popover visible. Added controlled `v-model:open` state to the Popover and an `openPanel()` handler that sets the active panel and closes the popover in one action

- **Context Bar Freezes After First Prompt**: Two independent causes. (1) `useContextPercentage` prioritized `contextTotalTokens` (set by `contextUsageSummary` 500ms post-query) over live `tokenUsageUpdate` tokens. After the first prompt set it, subsequent prompts' live data was ignored. Fix: `clearContextStats()` on `processing: true` removes the authoritative context fields, forcing fallback to live computation. (2) `refreshContextUsageSummary` starts an async `getContextUsage()` (~3-5s) that completes after the next query starts, sending stale data that re-freezes the bar. `clearTimeout` alone is insufficient — the timer fires before `handleInput` runs and the async operation continues. Fix: `processingGeneration` counter on `StreamingState` increments on every `setProcessing(true)` (covers all 3 query-start sites); `refreshContextUsageSummary` captures the generation before the await and skips sending if it changed

- **Output Tokens Only Update at Stream End**: The SDK `assistant` message fires per content block (not per API call) with a tiny non-representative `usage.output_tokens` (~1-6 tokens vs actual 100-300). The real per-call output count is in `message_delta.usage.output_tokens`. Moved accumulation from `assistant-processor` to `handleMessageDelta` in `stream-event-processor`, which fires once per API call with accurate data. `cumulativeOutputTokens` on `StreamingState` resets per-query via `setProcessing(true)`. `tokenUsageUpdate` fields now all optional so `message_delta` can send output-only updates while `assistant` sends input/cache-only updates

## [1.7.5] - 2026-04-12

### Fixed

- **1M Context Toggle Stays Enabled for Unsupported Models**: The "1M Context" toggle (`context-1m-2025-08-07` beta) remained enabled when switching from Opus 4.6 to Sonnet 4.6 because `modelSupports1MContext()` used regex `/claude-(?:sonnet|opus)-4/` which matched both. Replaced duplicate regexes (backend `utils.ts` + webview `SettingsPanel.vue`) with a single `supports1MContext` property on `ModelInfo`, set only on Opus 4.6 in `DEFAULT_MODELS`. `BetaManager.getActiveBetasForPanel()` now filters by model capability at read time — the user's preference stays in config and in-memory state, unsupported betas are excluded from the effective list sent to SDK and webview. Switching away from Opus 4.6 hides the 1M beta; switching back restores it automatically. Removed `handleModelBetaCleanupForPanel()` (config-mutating cleanup is no longer needed)

- **SDK Models Missing Custom Properties**: `getSupportedModels()` in `query-manager.ts` cast SDK model objects as `ModelInfo[]` without merging local properties (`supports1MContext`, `contextWindow`). When the SDK returned models, the webview's `currentModelInfo` found SDK objects lacking our custom properties, causing `supports1MContext` to always be `undefined`. SDK models are now enriched with `DEFAULT_MODELS` properties via spread merge (`{ ...local, ...sdk }`) so SDK values take precedence while local-only properties are preserved

## [1.7.4] - 2026-04-12

### Added

- **Programmatic Review Gate**: `team_approve_specialist` and `team_request_revision` are now mechanically blocked until all specialists have settled into review-ready states (`awaiting-review`, `completed`, or `cancelled`). Previously the lead agent wasted ~$0.15-0.20 in Opus tokens per session on premature review attempts. New `isReviewRoundReady()` dynamic check (no stored boolean) and `getNonSettledSpecialistDetails()` on TeamRunner, exposed via `AgentMcpContext`. Error messages include specialist names, statuses, and tool call counts. Follows the existing `team_synthesize_result` guard pattern

- **Approve-After-Revise Race Fix**: `approveSpecialist()` now rejects approval when the specialist has a pending revision (`!pendingReportComplete.has(name)`). Previously, after `requestRevision(B)`, the lead could call `approveSpecialist(B)` in the same turn — the status check passed because the specialist's status only transitions to `running` asynchronously via `onKeepAliveResume`

- **Lead Broadcast Filter**: Lead agent now has `shouldDeliverMessage: (msg) => msg.to !== null` — filters out all broadcast messages (scratchpad updates). Lead only wakes on direct messages: `[REVIEW ROUND READY]`, direct specialist questions. Prevents the lead from waking on intermediate scratchpad writes and wasting tokens on premature facilitation

- **Lead Keep-Alive Timeout**: Lead now uses `SPECIALIST_KEEPALIVE_TIMEOUT_MS` (600s) instead of the default 120s. Eliminates 2-minute timeout wake-ups that produced nothing useful while specialists are working. Safety-net timeout still fires at 10 minutes for edge cases

### Changed

- **Keep-Alive Message**: Awaiting-review specialists now show as count-only (`"2 awaiting review"`) instead of listing individual names (`"Awaiting review: Alice, Bob"`). Removes the temptation trigger that caused premature review attempts. Running and standby specialists still show names

- **Specialist Step 7 — No Direct Completion Message**: Specialists no longer send a completion message to the lead before calling `team_report_complete`. The direct message was a Phase 4 artifact that caused premature lead wakeups — the specialist sent the message while still `running`, the lead woke and tried to act before `awaiting-review` status took effect. Specialists now ensure their scratchpad section is complete, then call `team_report_complete` directly. The lead reads scratchpad sections after `[REVIEW ROUND READY]`

- **Lead Prompt — Phase 4/5 Merged**: Old Phase 4 (Facilitate Deliberation) removed — specialists handle cross-review autonomously via task prompt instructions. Old Phase 5 (Mandatory Review & Synthesize) renumbered to Phase 4. Turn Management section updated: lead no longer receives intermediate specialist updates, only `[REVIEW ROUND READY]` and direct messages

## [1.7.3] - 2026-04-12

### Added

- **REFERENCES Edge Kind**: New edge type for function-as-value detection — dispatch maps (`{ handler: myFn }`), callback registration (`register(myFn)`), array/tuple literals (`[fn1, fn2]`), and shorthand properties (`{ myFn }`). `walkReferences` runs alongside `walkCalls` during the call-graph pass. Only emits for identifiers that resolve to known graph nodes. New `references_of` / `referencers_of` query patterns in `compass_query`. Risk scoring in `changes.ts` now includes REFERENCES alongside CALLS for caller count and cross-community risk

- **JSX Component CALLS Edges**: `<MyComponent />` and `<MyComponent>` in TSX/JSX now emit CALLS edges from the rendering function to the component. Uppercase tags follow React convention (component); lowercase tags ignored (intrinsic DOM elements). `Foo.Bar` member expressions resolved via base name

- **Go Method Receiver Attachment**: `func (r *InMemoryRepo) FindByID(...)` now creates `FindByID` as a member of `InMemoryRepo` with `parent_name` and a CONTAINS edge, instead of a top-level function. Handles both value (`T`) and pointer (`*T`) receivers

- **inheritors_of Bare-Name Fallback**: When `inheritors_of` or `callers_of` queries return empty results (common when INHERITS/IMPLEMENTS edges store bare names), falls back to suffix-matching against edge targets. New `getEdgesByTargetName` method on GraphStore with LIKE wildcard escaping

- **Compass Validation Panel**: New `CompassValidationPanel.vue` overlay with `runValidation()` on GraphStore — reports broken edges, orphaned nodes by kind, unresolved external references, stale files, community gaps, and FTS sync status. Accessible via "Validate" button in the Compass indicator popover. Issues sorted by severity (error → warning → info) with expandable entity lists

- **Compass Per-Turn Context Injection**: `UserPromptSubmit` hook injects a compact `<damocles_compass>` XML tag with graph state, node/edge counts, and staleness indicator on every prompt. Enables Claude to proactively suggest reindexing when the graph is stale

- **External Edge Resolution**: `resolveExternalEdges()` now runs post-build in both full and incremental builds. Resolves unambiguous bare-name targets (e.g., `UserRepository` → `path.php::UserRepository`) for IMPORTS_FROM, INHERITS, IMPLEMENTS, and DEPENDS_ON edges

- **Compass System Prompt Integration**: When Compass is enabled, session guidance section now recommends Compass search before Glob/Grep for entity discovery

### Changed

- **Skip Directories**: Added `vendor`, `.bundle`, `.gradle`, `.dart_tool`, `.pub-cache`, `coverage`, `.cache` to `SKIP_DIRS` in `detect.ts` — prevents indexing PHP/Go vendor deps, test coverage output, and framework caches

- **Edge Weights**: `REFERENCES: 0.4` added to community detection Louvain weights (same weight as TESTED_BY)

## [1.7.2] - 2026-04-11

### Added

- **Monitor Tool Card**: Dedicated `MonitorCard.vue` for the SDK's `Monitor` tool with live state transitions (starting → monitoring → completed/failed/stopped), pulsing dot animation during active monitoring, event count tracking, elapsed timer, and persistent/timeout metadata display. Click-to-expand opens `ToolOverlay` with command (syntax-highlighted), description, and timeout details

- **Monitor Event Parsing**: `parseMonitorEventXml()` in `user-processor.ts` extracts monitor events from `<task-notification>` XML containing `<event>` tags. Previously these were silently dropped because `parseTaskNotificationXml()` requires `<result>` + `<tool-use-id>` which monitor events lack. New `monitorEvent` message type in `ExtensionToWebviewMessage` union

- **Monitor Store**: `useMonitorStore` Pinia store with `Map`-based state, `taskToToolUse` reverse lookup, and full lifecycle actions: `trackInput` → `registerMonitor` → `activateMonitor` → `incrementEventCount` → `completeMonitor`. History support via `restoreFromHistory` with event count reconstruction from replayed messages

- **Monitor History Support**: Monitor cards render correctly when loading sessions from history. `TOOL_METADATA_REGISTRY` entry extracts `taskId`/`timeoutMs`/`persistent` from JSONL `toolUseResult`. Event counts reconstructed from chronologically replayed `monitorEvent` messages

### Fixed

- **Knowledge Graph Community Switching**: Fixed D3 force-directed graph freezing when selecting a different community from the dropdown a second time. Root cause: `containerRef.value.innerHTML = ''` destroyed Vue's loading overlay vnode inside the container div, breaking Vue's virtual DOM reconciliation on subsequent renders. Fix: replaced with `d3Modules.select(containerRef.value).selectAll('svg').remove()` to remove only D3-created elements. Also converted 6 module-level `let` variables to `shallowRef` with proper D3 teardown order (remove tick handler → stop simulation → unbind zoom/drag via D3 namespace API → null refs → remove SVGs)

## [1.7.1] - 2026-04-11

### Added

- **Custom System Prompt**: Replaced SDK's `claude_code` preset with a custom `systemPrompt: string` built by `system-prompt.ts`. Drops the auto-memory section (~800 tokens saved per query) since Damocles has its own Memory module. Integrates caveman-lite output rules (no filler, no hedging, lead with action) and the anti-verbosity Communication style section with numeric length anchors. Memory/Compass/Recall prompts conditionally concatenated

- **GitHub Sponsors**: `sponsor` field in `package.json` links to GitHub Sponsors page for VS Code Marketplace integration

### Changed

- **`query-manager.ts`**: `systemPrompt` switched from `{ type: "preset", preset: "claude_code" }` to a composed string. `tools` preset unchanged
- **SDK Integration docs in CLAUDE.md**: Updated to document custom system prompt and SDK subagent registration

## [1.7.0] - 2026-04-10

### Added

- **Compass v2 — SQLite-Backed Knowledge Graph**: Complete rewrite of the Compass module from in-memory graphology to persistent SQLite (sql.js-fts5). The graph survives VS Code restarts — no re-indexing on launch. Atomic write-and-rename persistence pattern ensures crash safety

- **14 MCP Tools** (up from 4): Core tools (`compass_context`, `compass_search`, `compass_query`, `compass_stats`), impact analysis (`compass_blast_radius`, `compass_detect_changes`, `compass_review_context`), flows & communities (`compass_list_flows`, `compass_get_flow`, `compass_list_communities`, `compass_get_community`, `compass_architecture`), and admin tools (`compass_build`, `compass_postprocess`). All tools support `detail_level` parameter (minimal/summary/full) for token efficiency. Read-only tools annotated with `readOnlyHint: true`

- **Vue SFC Parsing**: New `tree-sitter-vue` grammar extracts functions, imports, and types from `<script>` and `<script setup>` blocks with correct absolute line offsets. Handles `lang="ts"`, plain JS, and empty scripts. All Vue-extracted nodes tagged with `language: "vue"`. Regex fallback when Vue grammar unavailable

- **Blast Radius / Impact Analysis**: BFS traversal from changed files through all 7 edge kinds (bidirectional). Configurable depth (default 2) and max results (default 500). Returns changed nodes, impacted nodes, impacted files, connecting edges, and truncation status

- **Risk-Scored Change Detection**: Parses `git diff --unified=0` output, maps changed lines to affected nodes, scores risk based on: security keywords, test coverage gaps, flow participation, caller count, cross-community callers. Risk levels: HIGH/MEDIUM/LOW with numeric scores

- **Execution Flow Tracing**: Detects entry points (zero incoming CALLS + framework decorators + conventional names), traces BFS call trees, scores criticality (file spread, external calls, security sensitivity, test gaps, depth). Stored in `flows` + `flow_memberships` tables

- **Community Detection**: Louvain via graphology-communities-louvain with deterministic `ORDER BY id` insertion. File-based fallback when node count exceeds 20K. Community naming from directory prefix + dominant class/keyword. Cohesion scoring (internal edges / total incident edges)

- **FTS5 Search**: BM25-ranked full-text search across `name`, `name_tokens`, `qualified_name`, `file_path`, `signature`. Content-sync FTS5 with triggers (not manual rebuild). `splitIdentifier("CompassService")` → `"compass service"` enables partial-name search. Kind boosting: PascalCase queries boost Class/Type, snake_case boosts Function

- **TypeScript Path Alias Resolution**: Walks up from source file to find `tsconfig.json`/`tsconfig.app.json`, reads `compilerOptions.paths` + `baseUrl`, resolves aliases like `@/components/Foo` → `src/components/Foo.vue`. Extension probing: `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `/index.*`. Per-directory caching. JSONC comment stripping with `extends` chain support

- **D3 Graph Visualization**: Interactive force-directed graph in the Damocles webview (`CompassGraph.vue`). D3 imported as sub-modules via dynamic `import()` with Vite `manualChunks` isolation. Per-community data fetching (max ~500 nodes). Community coloring, node kind sizing, edge kind differentiation (solid/dashed/dotted). Zoom, pan, drag, hover tooltips. Click-to-navigate. Blast radius overlay mode (impacted nodes highlighted, others dimmed)

- **Search Panel**: `CompassSearchPanel.vue` with debounced text input, kind filter chips (All/File/Class/Function/Type/Test), FTS5-powered results with click-to-navigate. Uses shadcn-vue Input, Badge, and ScrollArea components

- **VS Code Tree View**: `CompassTreeProvider` registered as "Compass" sidebar view. Files → Symbols hierarchy with kind icons. Click navigates to source. `BlastRadiusTreeProvider` shows changed/impacted groups. Status bar item with node count, indexing state, and click-to-rebuild

- **Editor Decorations**: Gutter decorations for blast radius — warning (red) for directly changed files, info (yellow) for transitively impacted. Hover shows node kind/name and impact classification. Auto-updates on active editor change

- **Incremental Updates**: Git-based delta detection (`git diff --name-only` + `git status --porcelain`). SHA-256 file hash skip for unchanged files. Transitive dependent invalidation (2-hop max). File rename/delete handling. Serialization after successful rebuild for crash recovery

- **15 Language Extractors** (up from 12): Python, JavaScript, TypeScript, TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, **Vue SFC**. Abstract classes and enums now properly extracted for TypeScript

### Changed

- **Storage Backend**: In-memory graphology graph replaced with persistent SQLite via sql.js-fts5. Database at `~/.damocles/compass/<workspace-hash>/graph.db`. Two-phase lazy init matching Memory module pattern
- **MCP Tool Count**: 4 tools → 14 tools. Old tools (`query_graph`, `inspect_node`, `graph_overview`, `trace_path`) replaced with domain-specific tools covering search, structured queries, impact analysis, flows, communities, and admin operations
- **Search**: Basic TF-IDF scoring replaced with FTS5 BM25 ranking with porter stemming and kind boosting
- **Community Detection**: Now uses pre-indexed edge lookup for cohesion computation — O(communities × avg_degree) instead of O(communities × total_edges)
- **`onStatusChange`**: Single-callback pattern replaced with callback array supporting multiple subscribers
- **`getGraphTerms`**: Algorithm extracted to standalone `expandGraphTerms()` in `search.ts` — both `CompassService` and tests call the same production code
- **Compass Section in CLAUDE.md**: Updated to reflect 14-tool architecture, SQLite storage, and new capabilities

### Removed

- In-memory graphology graph (`build.ts`, `cache.ts`, `cluster.ts`, `query.ts`, `analyze.ts`, `report.ts`, `export.ts`, `validate.ts`, `cross-file-resolver.ts`, `sanitize.ts`)
- Old test files (`analyze.test.ts`, `build.test.ts`, `cache.test.ts`, `cluster.test.ts`, `code-review-fixes.test.ts`, `confidence.test.ts`, `export.test.ts`, `pipeline.test.ts`, `report.test.ts`, `semantic-similarity.test.ts`, `validate.test.ts`)
- `graphify` evaluation code (replaced by code-review-graph TypeScript port)

### Dependencies

- Added `d3-force`, `d3-selection`, `d3-zoom`, `d3-drag`, `d3-scale` (webview, dynamic import)
- Added `tree-sitter-vue.wasm` (fetched at build time via `scripts/fetch-grammars.mjs`)

### Tests

- 908 tests passing across 34 test files (up from 129 tests / 15 files)
- New test files: `database.test.ts`, `search.test.ts`, `parser.test.ts`, `impact.test.ts`, `changes.test.ts`, `flows.test.ts`, `communities.test.ts`, `incremental.test.ts`, `tsconfig-resolver.test.ts`, `compass.bench.ts`
- Performance benchmarks: cold-start, full rebuild, incremental update, FTS5 search, blast radius

## [1.6.2] - 2026-04-06

### Added

- **Specialist Keep-Alive: Review Rounds + Standby**: Specialists now persist across SDK turns via the same keep-alive mechanism the lead uses, enabling two distinct waiting states:
  - **Standby** (`team_standby`) — specialist pauses mid-work waiting for peer input. Automatically resumes when any teammate writes to the scratchpad or sends a message. Eliminates wasteful polling of `team_read_scratchpad`/`team_read_messages` in loops
  - **Awaiting Review** (`team_report_complete`) — specialist signals work is done and enters awaiting-review. The system waits until all specialists are in awaiting-review, then notifies the lead to begin a review round
  - **Monitoring** — lead status while idle in keep-alive waiting for specialists
- **Mandatory Review Gate**: `team_synthesize_result` now rejects if any specialist is in awaiting-review without being explicitly reviewed. The lead MUST call `team_approve_specialist` (moves specialist to completed) or `team_request_revision` (sends corrections, max 2 rounds) for every specialist before synthesis is allowed. Mechanically enforced, not prompt-guided
- **4 New Team MCP Tools**: `team_standby` (specialist-only), `team_report_complete` (specialist-only), `team_request_revision` (lead-only, max 2 rounds), `team_approve_specialist` (lead-only, moves specialist to completed)
- **All-Awaiting-Review Notification**: When all specialists enter awaiting-review (or terminal state), a system message is sent to the lead via MessageBus listing unreviewed specialists and instructing the review workflow
- **Scratchpad → MessageBus Bridge**: Scratchpad writes now broadcast via MessageBus, waking standby and monitoring agents. Awaiting-review specialists filter out broadcasts via `shouldDeliverMessage` — only direct messages can wake them. Author filtered out by existing `msg.from !== config.name` guard
- **Token Usage Tracking**: Per-specialist token counts (input, output, cache read, cache creation) and cost extracted from SDK `result` event. Displayed in TeamAgentCard footer and TeamAgentOverlay subtitle. Aggregated team totals in TeamOverlay subtitle. Persisted in agent-completed JSONL entries and restored on history load
- **Lead Model Enforcement**: Lead agent always uses `claude-opus-4-6[1m]` regardless of model specified in `create_team`. The `model` parameter is ignored for lead agents in both `create_team` and the internal spawn path

### Changed

- **Team Model Selection Constrained to Allowed List**: Team MCP tools (`create_team`, `team_spawn_specialist`) now restrict the `model` parameter to an enum of 3 allowed models: Opus 4.6 (1M context), Sonnet 4.6, and Haiku 4.5. Previously accepted any arbitrary string, deferring validation to the API. Opus 4.5 excluded from team use
- **Team Quality Standards in Agent Prompts**: Added quality standards section to lead agent prompt (Section 7 — enforced during synthesis review), unprofiled specialist prompt (Section 7), and profiled specialist prompt (subsection in Rules). Standards: no bandaid fixes, root cause over symptoms, no speculative abstractions, no silent error swallowing. Lead is instructed to reject specialist work that violates these standards
- **Lead Keep-Alive Condition Expanded**: Lead now stays alive while any specialist is in `running`, `pending`, `awaiting-review`, or `standby` status (previously only `running`/`pending`)
- **Lead Keep-Alive Message Enhanced**: Status summary now includes awaiting-review and standby specialist counts alongside running specialists
- **Lead Phase 5 Rewritten**: "Verify & Synthesize" → "Mandatory Review & Synthesize" with hard gate. Lead must explicitly approve or revise every specialist — `team_synthesize_result` rejects until all specialists are reviewed. Lead must now wait for `[REVIEW ROUND READY]` notification before attempting any approve/revise calls (same stop-and-wait pattern as post-spawn). After revision, lead must re-read scratchpad to verify fix before approving. Turn Management (Section 10) updated to cover review-round waiting
- **Specialist Prompts Updated**: Both profiled and unprofiled prompts add standby instructions, post-report lifecycle documentation, and `team_standby`/`team_report_complete` tool table entries. Peer collaboration section now instructs standby instead of polling
- **Specialist Cancelled→Completed Override**: Specialists cancelled during synthesis cleanup or after lead approval now show 'completed'. Uses `reviewedSpecialists` set in addition to `completionResolved` for the override check
- **Agent Runner Hooks**: 3 new hook points — `onTurnEnd` (before `waitForMessage`), `onKeepAliveResume` (before `flushPendingMessages`), configurable `keepAliveTimeoutMs` (specialists get 600s vs lead's 120s), `shouldDeliverMessage` (message filter callback for selective wake)

### Fixed

- **Awaiting-Review Specialists Ejected by Scratchpad Broadcasts**: Scratchpad updates broadcast via MessageBus woke specialists in awaiting-review state. `onKeepAliveResume` cleared `pendingReportComplete`, causing `keepAlive()` to return false and terminating the specialist's session. Fixed with two changes: (1) `shouldDeliverMessage` callback on `AgentRunConfig` — specialists in `pendingReportComplete` filter out broadcast messages (`msg.to === null`), preventing the wake entirely; (2) `onKeepAliveResume` no longer clears `pendingReportComplete` — only `requestRevision()` does, so peer direct messages process one turn then re-enter awaiting-review

- **Team History Intermittent Load Failure — Session ID Race Condition**: `TeamService.loadTeamFromHistory()` and `loadAgentConversation()` resolved the persistence session ID via a getter closure only set inside `ensureStreamingQuery()` (async, not awaited). On fresh extension start, the getter was null, silently returning empty data. On subsequent loads, a stale getter from a prior query happened to work. Fixed by threading the explicit `sessionId` through the entire history loading path: `emitTeamCorrelations` → `loadTeamData` callback → `TeamService` methods, and passing `ctx.session.persistenceSessionId` from on-demand handlers. Getter preserved as fallback for live sessions
- **Lead Agent Shows "cancelled" After Successful Synthesis**: After the lead called `team_synthesize_result`, the team-runner aborted all agents (including the lead) for cleanup, causing `agent-runner` to report `status: 'cancelled'`. The `.then()` block in `team-runner` now applies a 3-way override: `cancelled` + `completionResolved` + `status !== 'cancelled'` → `'completed'`. Sends a correcting `teamAgentStatusUpdate` to the webview. User cancellation and pre-synthesis aborts still correctly show 'cancelled'
- **Silent Error Swallowing in Team Persistence**: `loadTeamState` and `loadAgentConversation` had bare `catch` blocks returning `null`/`[]` with no logging. Added `log()` calls with team ID, agent ID, file path, and error details. Also added logging to `TeamService` when resolved session ID is empty
- **Pending Team Placeholder Not Recovered**: When the primary history load path failed (Bug 1), placeholder teams with `pending-*` IDs persisted with no way to recover real data. Added `requestTeamDataByToolUse` message type — when `TeamOverlay` opens a pending team, it requests recovery by `toolUseId`. The extension reads the session JSONL for the `team-correlation` entry and sends the real `teamStarted` data
- **Live Token/Cost Data Never Reached Webview**: `onUsageUpdate` in team-runner updated the extension-side agent object but never sent a message to the webview. Token counts and cost in TeamAgentCard and TeamOverlay subtitle were always 0 during live operation (only populated on history reload). Added `teamAgentUsageUpdate` message type emitted on every SDK `result` event, with corresponding webview handler and store method
- **requestTeamDataByToolUse Loaded Entire Session JSONL**: The recovery handler called `readSessionEntries()` which parsed every line into objects just to find a single `team-correlation` entry. Replaced with `readline`-based line-by-line streaming with `JSON.parse` only on lines containing `team-correlation`, plus early break on match. Also removed unsafe `as unknown as` casts in favor of bracket-access type guards, and eliminated the direct `readSessionEntries` import in favor of `getSessionFilePath`
- **Agent Elapsed Timer Frozen During Standby/Awaiting-Review**: `TeamAgentCard` timer only ticked for `status === 'running'`. Agents in `awaiting-review`, `standby`, or `monitoring` showed frozen elapsed time. Timer now ticks for all alive states
- **Inconsistent Map Cleanup in synthesizeResult**: `synthesizeResult` cleared `pendingStandby` and `pendingReportComplete` but not `specialistReviewRounds`, `reviewedSpecialists`, `cancelAttempts`, or `cancellationTimestamps`. Added `.clear()` for all tracking maps
- **getRunningSpecialistNames Misnamed**: Method returned both running and pending agents. Renamed to `getActiveSpecialistNames` across types, team-runner, and mcp-server

## [1.6.1] - 2026-04-06

### Fixed

- **Team Card Not Rendering — Race Condition + Missing History Restoration**: `mcp__damocles-team__create_team` tool calls showed the generic MCP tool card instead of the specialized TeamCard. Two root causes: (1) fresh sessions had a race condition where the tool_use block rendered before the async `teamStarted` message populated the team store, and (2) history/recall loading never called `restoreTeamFromHistory` despite the function existing. Fixed by adding eager `registerTeamFromTool()` in the `toolStreaming` handler (same pattern subagents use via `registerAgentTool`), adding team restoration in both `assistantReplay` and `historyChunk` history handlers, and adding name-based routing guards so team MCP tools never fall through to `ToolCallCard`. Management tools (`get_team_status`, `cancel_team`) are now hidden like task management tools
- **Team Store Bypassing DI in Handlers**: `tool-handlers.ts` and `history-handlers.ts` called `useTeamStore()` directly instead of using the `StoreContext` dependency injection pattern that all other stores use. Added `teamStore` to `StoreContext` interface and wired it through `index.ts`. All 4 handler call sites now use `ctx.stores.teamStore`
- **Failed Team Status Lost on History Reload**: History restoration mapped team tool results to only `'completed'` or `'cancelled'`, ignoring the `'failed'` state. Teams that errored showed a `'completed'` badge on reload. Now checks `tool.isError` first → `'failed'`, then `tool.result` → `'completed'`, else `'cancelled'`
- **Compass `findNode` Label Ambiguity**: `get_node("EffectActivationService")` returned the interface (`IEffectActivationService`, degree=1) instead of the implementation (degree=49) because `findNode` used graph insertion order. Now ranks matches in three tiers — exact label match > starts-with > substring — with degree as tiebreaker within each tier
- **Compass `scoreNodes` Wrong-Domain Matches**: Replaced naive substring matching with BM25 IDF-weighted scoring: camelCase-aware word splitting, stop-word filtering, and `log(1 + (N - df + 0.5) / (df + 0.5))` weighting that penalizes terms appearing in many nodes
- **Compass `inspectNode` Depth-2 Duplicate Edges**: Two overlapping loops both collected edges from the target node, using `Array.includes()` for O(n²) string dedup. Rewrote to single `G.forEachEdge()` pass with Set-based key dedup
- **Compass BFS Edge Array Duplicates**: `bfs()` accumulated duplicate edges when multiple frontier nodes shared a neighbor. Removed the unused edge array and added `!nextFrontier.has(neighbor)` guard

### Changed

- **Compass Redesign: 9 Tools → 4 Tools**: Replaced 9 MCP tools with 4 purpose-built tools based on A/B testing evidence. Compass-enabled agents previously read fewer files (6 vs 19) and missed key entities (0/11 param classes found) due to `query_graph` conflating search with BFS traversal, producing 60-node dumps where 80%+ was noise. New tools: `query_graph` (pure entity search, no BFS, supports `kind` filter), `inspect_node` (merges `get_node` + `get_neighbors`, depth=1/2), `graph_overview` (merges `graph_stats` + `god_nodes` + `get_community` + `compass_status` + `compass_reindex` via `view` parameter), `trace_path` (renamed `shortest_path`)
- **`EntityKind` Data Model**: All 12 language extractors now tag nodes with `kind` (`file`/`class`/`function`/`method`/`type`/`import`). Flows through `GraphNode` → `build.ts` → `GraphNodeAttributes`. Enables kind-based search filtering in `query_graph`
- **Compass System Prompt — Pre-Query Injection**: Rewritten based on A/B testing (7 runs comparing Compass vs no-Compass subagents). Main prompt positions Compass as a targeting system with budget caps (2-3 calls max). Subagent delegation now uses pre-query injection: parent calls `query_graph` and injects entity list into subagent prompt, so subagent spends 100% of tool calls on file reading. `COMPASS_AGENT_PROMPT` is conditional — skips Compass tools when entity context is already injected

### Removed

- Dead types `QueryResult` and `PathResult` from `types.ts` — unused after query engine refactor
- Dead export `TEAM_MCP_PREFIX` from `tool-names.ts` — never imported anywhere
- Old query functions: `queryGraph`, `getNodeInfo`, `getNeighbors`, `getCommunityInfo`, `getGraphStats`, `shortestPath`, `subgraphToText`, `dfs`, `rankByRelevance`, `selectDiverseSeeds`
- Old facade methods: `queryGraph`, `getNode`, `getNeighbors`, `shortestPath`, `getGodNodes`, `getCommunity`, `getGraphStats`

## [1.6.0] - 2026-04-06

### Added

- **Compass — Workspace Knowledge Graph**: Converts workspaces into queryable knowledge graphs via tree-sitter AST extraction + Louvain community detection. Achieves token compression for structural codebase understanding vs. reading raw files. Disabled by default; enable via `damocles.compass.enabled`
- **12-Language AST Extraction**: Python, JavaScript/JSX, TypeScript, TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP — each extractor produces file nodes, class/struct nodes, function/method nodes, import edges, inheritance edges, and INFERRED call-graph edges
- **9 Compass MCP Tools**: `query_graph` (BFS/DFS traversal with term scoring), `get_node` (entity details), `get_neighbors` (direct dependencies), `shortest_path` (connection chain), `god_nodes` (hub entities), `get_community` (Louvain cluster members), `graph_stats` (confidence breakdown), `compass_reindex` (trigger rebuild), `compass_status` (indexing state)
- **Compass System Prompt**: When Compass is enabled, Claude's system prompt is augmented with tool usage guidance — directs Claude to prefer Compass tools over Read/Grep for structural codebase questions, using file reads only for exact source contents or editing
- **Recall Orientation BM25 Boost**: When Compass is enabled + indexed, `CompassService` is wired as a `CompassTermProvider` into `RecallService`. Graph neighbor labels expand BM25 queries during orientation — e.g., querying "auth" also searches for `AuthMiddleware`, `SessionStore`, `PermissionHandler` found via graph traversal. Pure in-memory lookup (~0.5ms)
- **Team Agent Compass Integration**: When both Compass and Team modules are enabled, all team agents (lead + specialists) receive the Compass MCP server and a system prompt snippet directing them to prefer graph queries. Lead agents can use `query_graph` and `get_community` to scope specialist tasks with structural data instead of vague descriptions
- **Disk-Persisted Extraction Cache**: SHA256-keyed per-file cache at `~/.damocles/compass-cache/{workspaceHash}/` — only changed files are re-extracted on VS Code restart (~100-150ms incremental vs 20-30s full rebuild)
- **Auto-Reindex**: FileSystemWatcher with 500ms debounce triggers incremental reindex on file saves (when `autoReindex=true`). Concurrent rebuild safety via `isRebuildInProgress` flag with pending queue
- **Compass Settings**: `damocles.compass.enabled` (boolean, default false), `damocles.compass.excludePatterns` (regex array), `damocles.compass.maxFiles` (default 5000), `damocles.compass.autoReindex` (default true)
- **Graph Analysis**: God node detection (degree-sorted, excluding file-level hubs), surprising cross-file connection scoring (confidence + file-type + community distance), suggested question generation from AMBIGUOUS edges, bridge nodes, and low-cohesion communities
- **Compass Test Suite**: 129 tests across 15 Vitest files covering validation, detection, caching, graph building, clustering, analysis, querying, export, reporting, MCP tools, service lifecycle, recall integration, and end-to-end pipeline
- **Compass Status Indicator**: SessionStats pill showing real-time indexing state — spinning compass with file count during indexing, green pill with node count when ready, red pill on error. Click-to-open popover displays full graph stats (files, nodes, edges, communities, last indexed time) with a Reindex button. State transitions broadcast from `CompassService` to all webview panels via `compassStatusUpdate` message

### Dependencies

- Added `graphology` ^0.26.0, `graphology-types` ^0.24.8, `graphology-communities-louvain` ^2.0.2, `web-tree-sitter` ^0.24.7
- Grammar WASM files fetched at build time via `npm run fetch:grammars` from `tree-sitter-wasms@0.1.13` — all 14 language parsers from a single source for consistent ABI, shipped as static assets in `resources/grammars/`

## [1.5.0] - 2026-04-04

### Added

- **Collaborative Multi-Agent Team System**: 2-5 specialist agents collaborate in real-time on complex tasks. A lead agent orchestrates the team — spawning specialists with specific assignments, coordinating via direct messaging, establishing shared contracts on a scratchpad, and synthesizing a final result. Powered by raw SDK `query()` calls with an in-process MCP server for inter-agent communication (no network overhead). Disabled by default; enable via `damocles.team.enabled`
- **Team MCP Tools (Main Session)**: `create_team` (blocks until team completes, returns synthesized result), `get_team_status`, `cancel_team`. Claude decides when to use teams based on task complexity
- **Team MCP Tools (Per-Agent)**: 7 tools for inter-agent collaboration — `team_send_message`, `team_read_messages`, `team_read_scratchpad`, `team_write_scratchpad`, `team_get_status`, `team_spawn_specialist` (lead-only), `team_synthesize_result` (lead-only)
- **Lead Keep-Alive**: Lead agent stays alive while specialists are running — `waitForMessage()` blocks on bus notifications with 30s timeout, injecting status prompts to prevent premature termination. Capped at 20 keep-alive cycles (~10 min idle)
- **Graceful Timeout**: System broadcasts a warning to all agents 60s before the team timeout fires, giving agents time to wrap up and synthesize partial results
- **Post-Synthesis Drain**: After the lead synthesizes, lingering specialists get 30s to finish before the team completes — prevents indefinite hangs from stuck agents
- **MCP Input Validation**: Zod schema validation at the tool boundary — task assignments require minimum 20 characters, message content capped at 32KB, scratchpad content at 64KB, section names 1-128 chars
- **TeamCard**: Inline card in chat replaces the `create_team` tool_use block, showing team title, agent count, status badge, and elapsed time. Click to open the TeamOverlay
- **TeamOverlay**: Full-screen overlay with four tabs — Agents (per-agent cards with colored stripes, status badges, tool counts), Timeline (chronological inter-agent messages with color-coded senders), Scratchpad (collapsible key-value entries with author badges), Result (synthesized output)
- **TeamIndicator**: Header bar indicator showing active team count with click-to-open overlay
- **Team JSONL Persistence**: Full team lifecycle persisted to `{session}/teams/{teamId}.jsonl` with per-agent SDK conversation in `teams/agents/{agentId}.jsonl`. `team-correlation` entries in main session JSONL enable history replay. `agent-completed` entries include `toolCallCount` for accurate history reconstruction
- **Team History Support**: Historical teams render as completed/failed TeamCards when loading past sessions
- **Team Settings**: `damocles.team.enabled` (boolean, default false), `damocles.team.timeout` (default 1800000ms / 30 minutes)
- **Structured Agent Prompts**: Lead prompt (~95 lines) with phased workflow, prompt-writing guidance with examples/anti-patterns, failure handling, and synthesis checklist. Specialist prompt (~55 lines) with structured workflow, completion report format, blocker escalation protocol, and scratchpad-first guidance
- **Specialist Agent Profiles**: 161 domain expertise profiles (from AgentLand) across 13 categories — Engineering, Design, Marketing, Game Development, Sales, and more. Lead agent selects the best-fit profile when spawning each specialist via the `profile` parameter on `team_spawn_specialist`. Profile identity, mission, and critical rules are interleaved into the specialist's system prompt, giving agents genuine domain expertise. Build-time registry generated from `agent-profiles/` source `.md` files via `npm run generate:profiles`

## [1.4.18] - 2026-04-03

### Changed

- **Max Turns Limit**: Increased `damocles.maxTurns` default from 100 → 300 and maximum from 200 → 1000, allowing longer agentic sessions without manual reconfiguration
- **SDK Upgraded**: `@anthropic-ai/claude-agent-sdk` ^0.2.90 → ^0.2.91

## [1.4.17] - 2026-04-03

### Fixed

- **Recall REPL Loop**: Removed redundant `maxTurns: 1` from recall root model calls and sub-call handler SDK queries. SDK 0.2.90 changed `maxTurns` enforcement — reaching the limit now throws instead of completing gracefully, causing every REPL iteration to fail with "Reached maximum number of turns (1)" and retry until the iteration cap. Since `tools: []` guarantees single-turn completion naturally, `maxTurns` was always redundant; the recall loop's own iteration limits (8 oriented / 15 unoriented) and 120s timeout provide the actual safety bounds

## [1.4.16] - 2026-04-02

### Changed

- **Two-Phase Lazy MemoryService**: Extension activation no longer blocks on WASM binary loading or database initialization. `MemoryService` constructor performs zero I/O (reads config only); `ensureInitialized()` defers WASM load, DB open, manager creation, file tracker init, and backfill to first access. All MCP tool handlers and memory message handlers gate on `ensureInitialized()`. `isEnabled` remains synchronous for `getMcpServerConfig()`
- **Async Injection Database**: `openInjectionDatabase()`, `InjectionManager.getOrOpenInjectionDb()`, and the full `persistMemoryInjection`/`getPersistedMemoryInjection` cascade converted from sync to async. Eliminates `fs.existsSync`/`fs.readFileSync`/`fs.mkdirSync` calls
- **Async Git Branch Resolution**: `TurnPersistence` constructor and `reset()` no longer call `execSync('git rev-parse')` (up to 3s timeout). Branch resolved asynchronously via `execFile` with generation guards preventing stale callbacks after reset
- **Parallel Config Loading**: `createSessionForPanel()` runs `loadMcpConfig()`, `loadPluginConfig()`, and `ensureSessionDir()` via `Promise.all()` instead of sequential awaits. `fixPackagePermissions()` in `activate()` changed to fire-and-forget
- **Session Metadata Cache**: New write-through `.session-index.json` cache reduces history dropdown load from 3-8s to <200ms for 100+ sessions. `listSessions()` uses stat-based freshness checks instead of full JSONL parsing. SDK metadata (tags, createdAt) fetched in background batches with 24h TTL
- **Early-Exit parseSessionFile**: Stops scanning after finding preview + 2 messages, with a 200-line cap for cache-miss fallback
- **Paginated Entry Cache**: `readSessionEntriesPaginated()` caches fully-processed entry lists (LRU, max 4). Subsequent "load more" pages return slices with zero I/O
- **buildSessionData Cache**: `buildSessionData()` caches build results keyed by main JSONL + node file mtimes (LRU, max 4). Session restoration hits cache on unchanged files
- **Lazy Webview Overlays**: 16 overlay components converted to `defineAsyncComponent()` — only loaded when their `v-if` condition triggers. Core components (MessageList, ChatInput, StatusBar, etc.) remain eagerly loaded
- **Production Sourcemap Removal**: `esbuild.config.mjs` now uses `sourcemap: isWatch` — dev/watch builds include sourcemaps, production builds omit them
- **Async Browser Discovery**: `findBrowser()` converted from `execSync('which')` to `execFileAsync('which')` with result caching. Eliminates shell injection vector

## [1.4.15] - 2026-04-01

### Changed

- **Permission Prompt Ordering**: Moved the "Run this command?" permission prompt above the Tasks section in the chat UI so approval requests are immediately visible without scrolling past the task list

## [1.4.14] - 2026-04-01

### Added

- **Hook Event Visibility**: Enabled `includeHookEvents: true` in SDK query options, activating the dormant hook lifecycle pipeline (`hook_started`/`hook_progress`/`hook_response` system messages). Hook data now flows through the existing streaming processors (`session-events-processor.ts`) into the webview's `activeHooks` store. Only the main user query opts in — `/btw` forks (no tools = no hooks) and recall queries (internal machinery) are excluded
- **StatusBar Hook Indicator**: Inline annotation in the processing status bar showing active hook events. Single hook displays the event type (e.g., `Hook: PreToolUse`), multiple concurrent hooks show a count. Styled as `text-xs opacity-40 not-italic` to remain visually subordinate to the main status text. Reactivity works via Map reference replacement in the store
- **i18n Hook Keys**: Added `status.hook` and `status.hooksCount` translation keys for both `en` and `el` locales

### Fixed

- **Stale Hook Cleanup**: `setProcessing(false)` now clears `activeHooks` in `useUIStore`. Previously, if a hook crashed before sending `hook_response`, stale entries remained in the Map and would persist across processing cycles. Cleanup fires on session cancel, conversation clear, and normal processing end — consistent with the existing incremental state management pattern (`uiStore.$reset()` is never called)

### Changed

- **SDK Upgraded**: `@anthropic-ai/claude-agent-sdk` ^0.2.87 → ^0.2.89

## [1.4.13] - 2026-03-29

### Fixed

- **PreToolUse Hook Permission Regression**: Reverted the v1.4.12 change that returned explicit `hookSpecificOutput: { permissionDecision: 'ask' }` from the PreToolUse hook for tools requiring user confirmation. The explicit 'ask' return forced the SDK to call `canUseTool` for tools (TaskCreate, TaskUpdate, TaskGet, TaskList, CronDelete, NotebookEdit, etc.) that the SDK's own built-in rules would normally auto-approve. These tools fell through to a generic `showInformationMessage` VS Code dialog instead of being handled silently. Restored `return {}` which lets the SDK apply its own permission rules before falling back to `canUseTool`

## [1.4.12] - 2026-03-28

### Added

- **Structured Context Usage API**: Replaced the fragile `/context` markdown parsing pipeline with the SDK's `getContextUsage()` structured API (SDK 0.2.86). `QueryManager.getContextUsage()` returns typed `ContextUsageData` directly — no more sending `/context` as a user message, intercepting the assistant response, or regex-parsing markdown tables. Deleted `context-usage-parser.ts` entirely. Removed `localCommandPending` flag and its interception logic from `assistant-processor.ts` and `StreamingState`
- **Post-Turn Context Stats**: `refreshContextUsageSummary()` fires after `result` messages via `StreamingManager.onResultProcessed` callback, debounced at 500ms to collapse rapid subagent completions. Sends `contextUsageSummary` to the webview with `totalTokens`, `maxTokens`, and `percentage` from the SDK — the SessionStats bar now shows accurate context window usage instead of cumulative token approximation. `useContextPercentage` prefers SDK-sourced values when available
- **Task Budget Setting**: New `damocles.taskBudget` configuration option (SDK 0.2.84 `taskBudget`). Passed to SDK as `{ taskBudget: { total: N } }` in query options. Full UI: number input in settings panel, message routing (`setTaskBudget`), `ConfigManager.handleSetTaskBudget()`, `ExtensionSettings.taskBudget` field
- **Plugin Reload**: `reloadPlugins()` method (SDK 0.2.85) exposed via `QueryManager.reloadPlugins()` → `ClaudeSession.reloadPlugins()`. "Reload All" ghost button added to MCP Status Panel header. Result dispatched as `pluginsReloaded` message with `errorCount` — webview shows success/warning toast
- **Context Usage Overlay Enhancements**: Overlay now renders SDK-provided categories with their native colors (no hardcoded category map). New collapsible sections: Message Breakdown (user/assistant/tool calls/results/attachments with per-type drilldowns), System Prompt Sections, System Tools, Deferred Builtin Tools (loaded/deferred badges), Slash Commands (included/total counts). Auto-compact threshold badge in header. API Usage footer with input/output/cache token stats

### Changed

- **`EffortLevel` Type Rename**: SDK 0.2.84 exports `EffortLevel` instead of the locally-defined `ReasoningEffort`. Renamed across all files: `settings.ts`, `messages.ts`, `App.vue`, `SettingsPanel.vue`, `config-manager.ts`, `settings-manager/index.ts`, `useSettingsStore.ts`
- **PreToolUse Hook Fix**: `hook-handlers.ts` now returns explicit `hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' }` instead of empty `{}` for tools requiring user confirmation. Fixes SDK 0.2.85 bug where empty returns caused `permissionDecision: 'ask'` hooks to be silently ignored
- **`ContextUsageData` Aligned to SDK**: Replaced the old `breakdown`/`details` sub-types with flat SDK-shaped fields: `categories[]`, `memoryFiles[]`, `mcpTools[]`, `agents[]`, `deferredBuiltinTools[]`, `systemTools[]`, `systemPromptSections[]`, `skills`, `slashCommands`, `messageBreakdown`, `apiUsage`, `autoCompactThreshold`, `isAutoCompactEnabled`. `usagePercentage` → `percentage`, added `rawMaxTokens`
- **SDK Upgraded**: `@anthropic-ai/claude-agent-sdk` ^0.2.83 → ^0.2.86
- **`max` Effort Level**: Added `"max"` to the `damocles.effort` configuration enum in `package.json`. Previously only `low`/`medium`/`high` were schema-valid — `max` was accepted at runtime (for Opus 4.6) but rejected by VS Code's JSON validation
- **Context Usage Error States**: `contextUsage` message `reason` changed from `'parseFailed'` to `'noQuery'` — the overlay now shows "no active session" instead of "parse failed" since parsing is no longer involved

### Fixed

- **Queued Message Loading Indicator**: Flushing a queued message as a new turn (text-only responses with no PostToolUse hook) now correctly shows the blue loading indicator. Root cause: `session_state_changed: idle` fired after `flushQueuedMessagesAsNewTurn()` set `processing = true` but before the SDK echoed the user message back — the session-state-processor immediately reset `processing = false`. Fix: the `idle` handler in `session-state-processor.ts` now checks `localPromptPending` and skips the processing reset when a flushed message is in-flight (the flag is cleared when the SDK echoes the `user` event in `user-processor.ts`)
- **Queued Message Duplicate Bubbles**: Queued messages that flushed immediately (model turn already ended) appeared twice in the chat — once from `queueBatchProcessed` and again from `messageQueued`. Root cause: `queueInput()` returned a boolean that couldn't distinguish between "deferred for turn-end" and "flushed immediately". When immediately flushed, `flushQueuedMessagesAsNewTurn()` sent `queueBatchProcessed` (creating the combined user bubble), then the chat handler saw `true` and sent `messageQueued` (creating a duplicate). Fix: `queueInput()` now returns `'queued' | 'flushed' | false` — the chat handler only sends `messageQueued` when the disposition is `'queued'`, skipping it entirely when the message was already represented via `queueBatchProcessed`

## [1.4.11] - 2026-03-25

### Added

- **SDK `seedReadState` Integration**: New `ReadStateTracker` captures file path + mtime on every Read tool completion via PostToolUse hook. On query recreation (recall mode's per-turn `closeAndReset()`, or after context compaction), all tracked reads are seeded into the new query via `Query.seedReadState()` — Edit operations now succeed without re-Reading the file. Tracker survives `closeAndReset()` but clears on full `reset()`
- **SDK `session_state_changed` Events**: Enabled via `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` env var in query options. New `session-state-processor.ts` handles `idle`/`running`/`requires_action` state changes — `idle` acts as an authoritative turn-over safety net (fires after `heldBackResult` flushes and background agent do-while exits), setting `processing = false` if the `result` processor didn't already. State forwarded to webview as `sessionStateChanged` message

### Changed

- **`/btw` Timeout Removal**: Removed the 60s `BTW_TIMEOUT_MS` timeout from the btw-handler entirely. `/btw` uses `maxTurns: 1` with no tools — it always completes in one model turn. The timeout was overly defensive and caused premature aborts for slow responses. User retains explicit cancel via `cancelBtw()`. In recall mode, the cross-node context retrieval (`getCrossNodeContext`) now passes `skipTimeout: true` to `runRecallLoop()`, lifting the 120s aggregate timeout while preserving per-iteration safety (60s `ITERATION_TIMEOUT_MS`)

## [1.4.10] - 2026-03-23

### Fixed

- **Browser Screenshot DPR Multiplication**: All three `captureScreenshot()` paths now account for Chrome's actual output formula: `outputPixels = clipWidth × clipScale × deviceScaleFactor`. With `Emulation.setDeviceMetricsOverride` active (set by `resizeViewport`), Chrome multiplies `clip.scale` by the emulated DPR — the v1.4.9 fix treated scale as a DPR replacement, producing `1091 × 1.787 × 2 = ~3900px` instead of the expected `1950px`. `CdpBridge` now tracks its own `emulatedDpr` (set in `setViewport`), eliminating hardcoded DPR assumptions from all screenshot paths: explicit clip (element picker), JS evaluate (normal screenshots), and the `Page.getLayoutMetrics` CDP fallback

## [1.4.9] - 2026-03-23

### Fixed

- **Chrome Launch as Root on Headless Linux**: `launchChrome()` now conditionally adds `--no-sandbox` when running as root (`process.getuid?.() === 0`). Chrome's sandbox relies on Linux user namespaces which are disallowed for root, causing `Chrome exited with code 1 before ready` on headless servers (e.g., Hetzner). The optional chaining on `getuid` ensures the flag is never added on Windows/macOS where the function doesn't exist, and is skipped for non-root Linux users to preserve sandbox security
- **Browser Screenshot 2000px Edge Case**: Reduced `SDK_MAX_DIMENSION` from 2000 to 1950 in `cdp-bridge.ts` to provide a safety margin against Chrome's internal floating-point rounding. With `dpr=2` on a ~1091px viewport, the previous downscale produced images at exactly 2000px — Chrome could round to 2001px, exceeding the SDK's hard limit and triggering a `sharp` resize fallback that itself failed. Added `Page.getLayoutMetrics` CDP fallback when the JS `evaluate()` call fails (e.g., during page load or on restricted pages), ensuring a safe clip is always computed

## [1.4.8] - 2026-03-23

### Fixed

- **Browser Detection on Linux/WSL2**: `findBrowser()` now includes `microsoft-edge-stable` and `microsoft-edge` in the Linux browser candidate list. Previously only Chrome and Chromium variants were checked, causing browser launch to fail in WSL2 environments where Microsoft Edge is the only available Chromium-based browser. Windows and macOS already had Edge fallbacks
- **Browser Screenshot SDK Rejection**: `captureScreenshot()` in `cdp-bridge.ts` now auto-downscales output to stay within the SDK's 2000x2000px image limit. Previously, the viewport's `deviceScaleFactor: 2` produced images up to 3840x2160px, which the SDK rejected with "Unable to resize image — dimensions exceed the 2000x2000px limit". The fix queries the browser's actual viewport size and DPR at capture time, computes the maximum safe scale (`min(dpr, 2000/w, 2000/h)`), and passes an explicit `clip.scale` to CDP when needed. Fixes all 11 screenshot-returning browser tools (`browser_open`, `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_hover`, `browser_scroll`, `browser_select`, `browser_fill`, `browser_drag`, `browser_wait`) plus the element picker — every path that calls `captureScreenshot()` is covered by this single fix

## [1.4.7] - 2026-03-21

### Added

- **Damocles Browser**: Integrated browser with full CDP automation — launches a headless Chromium instance and renders it via screencast in a VS Code editor panel with a toolbar (back, forward, reload, URL bar, element picker, DevTools). User sees and interacts with the browser live (click, type, scroll, copy/paste, keyboard input). Zero external dependencies — Chrome DevTools Protocol commands route through a raw WebSocket (`CdpSocket`) with binary frame parsing
- **Browser MCP Server**: In-process MCP server (`damocles-browser`) exposing 15 tools to Claude: `browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_element`, `browser_evaluate`, `browser_console`, `browser_network`, `browser_accessibility`, `browser_hover`, `browser_scroll`, `browser_select`, `browser_wait`, `browser_drag`, `browser_fill`, `browser_close`, plus `browser_query` (page snapshot with interactive element refs). All mutating tools return a screenshot so Claude sees the result. Follows the `damocles-memory` in-process MCP pattern — injected via `QueryManager.mcpServers`
- **Element Picker**: CDP `Overlay.setInspectMode` integration — user picks elements from the browser panel (crosshair cursor), captures DOM (`outerHTML`), computed CSS (matched rules via `CSS.getMatchedStylesForNode`), bounding box, cropped element screenshot, console messages, and network errors. Results sent to chat input as `ElementAttachment` cards via `useElementAttachments` composable. Max 5 attachments per message. Serialized as `TextBlock` (structured context) + `ImageBlock` (element screenshot)
- **Browser Panel** (`browser-panel.ts`): Custom webview panel with screencast rendering (JPEG frames via `Page.screencastFrame`), toolbar with navigation controls, coordinate-mapped mouse/keyboard event forwarding, viewport resize handling, element overlay info display, and DevTools button
- **CDP Socket** (`cdp-socket.ts`): Raw WebSocket client with RFC 6455 binary frame parsing, fragmented message reassembly, and JSON-RPC command/event multiplexing — connects to Chrome's browser-level WebSocket for multi-target session management
- **DevTools Integration**: Opens Chrome DevTools in an external browser by detaching the CDP session, polls `/json` endpoint to detect DevTools closure, then reattaches and reconnects CDP domains automatically
- **Browser Toggle**: `damocles.browser.enabled` setting with `BrowserManager` (mirrors `ChromeManager` pattern). Appears in MCP status panel with toggle switch. When enabled, `damocles-browser` MCP server is injected into SDK queries
- **Element Attachment Strip** (`ElementAttachmentStrip.vue`): Horizontal scrollable strip of element attachment cards in chat input area — shows purple "ELEMENT" badge, CSS selector, tag name, dimensions, dismiss button. Rendered between text area and image strip in `ChatInput.vue`

### Changed

- **Session File Caching**: `readSessionFileLines()` now caches parsed lines keyed by `(filePath, mtimeMs, size)` with LRU eviction (max 8 entries). `parseAllSessionEntries()` uses a `WeakMap` entry cache. `readSessionFileTail()` reads only the last 64KB for functions that scan from the end (e.g., `getLastMessageUuid`, `readLatestCompactSummary`). Cache invalidated on rename/delete via `invalidateSessionFileCache()`

## [1.4.6] - 2026-03-20

### Added

- **Auto-Orientation Pipeline**: Two-stage REPL loop restructure for recall mode. When a task node exceeds 400K chars and the REPL fallback triggers, an automatic orientation pipeline now runs before the root model starts — query expansion via Haiku (`expandQuery()`), BM25 ranking across all turns, and optional chunk investigation for vague queries (BM25 top score < 2.0). The root model enters the sandbox pre-oriented with ranked results, needing only ~8 iterations instead of 15
- **BM25 Text Search Engine** (`bm25.ts`): Pure-JS in-memory BM25 (Okapi) implementation. Builds an inverted index from turn text + Haiku-generated keywords, tokenizes with stop-word removal, and scores via TF-IDF with document length normalization. Exposed to the REPL sandbox as `text_search(query, topK?)` for follow-up searches with different terms
- **Turn Indexer** (`turn-indexer.ts`): Write-time enrichment — after each turn completes, Haiku generates a one-line summary and 3-10 domain-specific keywords (file paths, technical terms, component names). Persisted as `turn-index` JSONL entries via `TurnPersistence.persistTurnIndexQueued()`. Patched back onto turns during session reload via `applyTurnIndices()`. Gracefully degrades for pre-existing sessions (BM25 falls back to raw turn text)
- **Orientation Context** (`orientation.ts`): Orchestrates query expansion → BM25 ranking → chunk investigation pipeline. `buildOrientationContext()` returns `OrientationContext { expandedTerms, bm25Results, turnIndex, investigationReport, durationMs }`. Investigation splits history into ~50K char chunks, sends each to Haiku with an investigator prompt, and deduplicates findings by turn index
- **REPL Sandbox Tools**: `turn_index` array (compact `{i, s, k, f}` per turn for quick scanning) and `text_search(query, topK?)` function injected into the JsRepl sandbox, giving the root model BM25 search capability within the REPL loop
- **Orientation Pipeline UI**: Live streaming of orientation phases in the Context Injection Overlay — Stage 1 (Orientation) shows expanded term badges, BM25 scored results with turn previews, and collapsible investigation reports; Stage 2 (REPL Retrieval) divider separates orientation from REPL iterations. Real-time phase indicators (`expanding → searching → investigating → complete`) stream via `orientationPhaseUpdate` message
- **Session Node Overlay Recall Attempts**: Per-node recall history section in the Session Node Overlay detail view. Shows each REPL invocation with prompt reference, iteration count, duration, and "Oriented"/"Direct" badges. Oriented attempts expand to show BM25 top results and expanded terms

### Fixed

- **Node JSONL Overwrite on Session Reload**: Loading a recall session from history and sending a new message no longer destroys prior turn data. Root cause: `persistUser()` in `ClaudeSession.sendMessage()` was called without the `nodeId` — user messages went to the main JSONL while assistant responses went to the node JSONL, forking the parent UUID chain and making prior responses invisible sidechains on reload. Fix: pass the already-computed `nodeId` to `persistUser()`. Defense-in-depth: `initNodeFile()` now checks file existence before writing (`fs.promises.access` guard), and `setSessionId()` pre-populates the `nodeFilesInitialized` cache from loaded node state via `markNodeInitialized()`

### Changed

- **REPL Max Iterations**: Oriented loops use 8 max iterations (down from 15). Unoriented loops (seed extraction, custom overrides) retain the configured maximum
- **System Prompt Restructured**: `buildRecallSystemPrompt()` now accepts optional `OrientationContext` and renders an `<orientation>` section with ranked results, expanded terms, and investigation reports. Examples updated to show orientation-first patterns
- **Initial Prompt Orientation-Aware**: `buildInitialPrompt()` checks for orientation results — if BM25 results exist, instructs the model to review ranked turns first; otherwise falls back to the original exploratory prompt
- **`RecallTrajectory` Extended**: New `orientation: OrientationData | null` field replaces flat tracking. `OrientationData` carries `expandedTerms`, `bm25Results`, `investigationReport`, and `durationMs`. BM25 type unified via shared `OrientationBM25Result`. History deserialization uses `normalizeTrajectory()` instead of ad-hoc field patching
- **`StructuredTurn` Extended**: New `summary: string | null` and `keywords: string[] | null` fields populated by the turn indexer
- **`nodeTurnsLoaded` Extended**: Now includes `recallAttempts: NodeRecallAttempt[]` for per-node recall history. `TrajectoryManager.getByNodeId()` queries trajectories scoped to a node

## [1.4.5] - 2026-03-20

### Fixed

- **Foreground Agents Triggering Background Task UI**: All Agent tool uses (foreground and background) incorrectly showed the blue "Background" badge on SubagentCard and populated the BackgroundTasksOverlay. Root cause: `consumeAgentInput()` in `ToolManager` prematurely deleted pending agent input before `task-lifecycle-processor` could read the `run_in_background` flag, and `resetToRunning()` in `useSubagentStore` hardcoded `isBackground: true` for all agents. Fix: renamed to non-destructive `getAgentInput()` (data cleaned up naturally by `resetTurn()`), gated `backgroundTaskStarted` emission behind actual `run_in_background` flag, and threaded `isBackground` through the `taskStarted` message to the webview

## [1.4.4] - 2026-03-20

### Added

- **Background Task Visibility**: Full lifecycle UI for SDK background agents (`run_in_background: true`). New `BackgroundTask` type, `useBackgroundTaskStore` Pinia store, `BackgroundTasksOverlay` (list + detail views with status badges, elapsed time, progress summaries, token/tool stats, stop/dismiss actions), and `BackgroundTasksIndicator` pill in session stats. Background task results appear as labeled assistant messages with a blue badge. Subagent cards show a "Background" badge via `isBackground` on `SubagentState`
- **Per-Node JSONL Files**: Turn persistence now writes to per-node files at `<sessionId>/nodes/<nodeId>.jsonl` instead of the monolithic session file. Main JSONL receives lightweight `node-turn-ref` entries for branch tracking and leaf state. `buildSessionData()` and `readSessionEntriesPaginated()` merge node file entries by timestamp. `initNodeFile()`, `buildNodeFilePath()`, `readNodeFileEntries()`, `mergeEntriesByTimestamp()` added to session/recall modules
- **Background Agent Persistence**: `SubagentManager` tracks tool calls (`pendingToolCalls`) and prompt for background agents. On `onSubagentStop()`, writes prompt → tool call/result pairs → final response to the agent JSONL in correct order. `ToolManager.consumeAgentInput()` captures `run_in_background`/`prompt` from Agent tool input for forwarding to `RecallService`
- **`stopTask()` on `ClaudeSession`**: Exposes `query.stopTask(taskId)` for stopping background tasks from the webview via the `stopBackgroundTask` message

### Fixed

- **Task-Notification XML Leaking as User Bubbles**: `<task-notification>` XML blocks from SDK background task completions no longer appear as visible user messages. Filtered in `user-processor.ts` (both `userReplay` and live content paths), `history-manager.ts` (`extractDisplayableUserContent`), and `hook-handlers.ts` (pass-through without remote reroute for `isMeta` messages)
- **Queued Message Duplicate Bubbles**: Combined queued messages now use `isCombinedQueue` flag and atomic filter-then-append instead of separate filter + push. `localPromptPending` set in `sendQueuedMessage()` to suppress the echo. Message list UI respects `isCombinedQueue` for prompt index counting, rewind buttons, context injection pills, and injected styling
- **History Tool Results Scoped to Page**: Tool results are now collected globally during `processEntriesSinglePass()` and propagated through `paginateEntries()` → `PaginatedSessionResult.toolResults`, replacing the per-page `collectToolResults()` that missed cross-page tool use/result pairs
- **Task-Notification Branch Graph Corruption**: `repairTaskNotificationBranching()` re-parents task-notification user entries whose `parentUuid` points to a non-conversation entry (e.g., a tool result), attaching them to the deepest conversation leaf of the fork point instead. Prevents branch detection from creating phantom sidechains
- **Assistant Message Deduplication Gap**: `processReplayEntries()` now uses a `Map<sdkMsgId, HistoryMessage>` for assistant dedup instead of tracking only the last message ID, fixing cases where non-adjacent assistant entries with the same `sdkMsgId` created duplicate bubbles

### Changed

- **SDK Dependency**: Bumped `@anthropic-ai/claude-agent-sdk` from `^0.2.75` to `^0.2.80`
- **Result Processor Unified Path**: `onResponseComplete` in result-processor now uses the same `fireTurnComplete()` → `fireTurnEndFlush()` flow for both recall and non-recall modes, removing the conditional branching
- **Subagent Store `resetToRunning()`**: New method resets a subagent card to running state with `isBackground: true` when `taskStarted` fires for a background agent whose tool card already exists
- **Recall Trajectories Persisted to Node Files**: `persistTrajectoryQueued()` resolves the target file path based on the trajectory's `nodeId`, writing to the node file instead of the main JSONL
- **Session Deletion Cleans Node Files**: `deleteSession()` now removes `<sessionId>/nodes/*.jsonl` before cleaning the session directory

## [1.4.3] - 2026-03-17

### Fixed

- **`/btw` Always Aborting in Recall Mode**: `sendWithContext()` silently dropped every `/btw` query when recall mode was active. The cancellation check `!this.activeAborts.has(btwId)` was always true because `btwId` was never registered — only `send()` did that, and it hadn't been called yet. Refactored `BtwHandler` to extract `executeQuery()` private method; both `send()` and `sendWithContext()` now own their AbortController lifecycle (create → register → execute → cleanup via `finally`). Cancellation during context fetch detected via `abortController.signal.aborted` instead of map membership

## [1.4.2] - 2026-03-17

### Added

- **Node Chip**: Non-blocking popover chip in the chat input bar replaces the blocking `NodePickerDialog` modal. Color-coded states — emerald (active node selected), indigo (pending new node), amber pulse (no node selected). Clicking opens a popover listing active nodes with checkmarks, turn counts, and age, plus a "New task" button. Eliminates UX friction — prompts submit immediately without modal interruption
- **Default Node Badge**: Active node surfaced in `TaskNodeCard` and `SessionNodeOverlay` detail view with "Default" badge. Active cards in the graph view show a "Set Default" button for switching the target node
- **Seed Context Regeneration**: Users can regenerate seed context from the Session Node Overlay detail view using a custom extraction instruction. New `seedContextPrompt` field on `TaskNode` persists the instruction. Regeneration runs through the existing REPL infrastructure with dedicated `buildSeedExtractionSystemPrompt()`/`buildSeedExtractionInitialPrompt()` prompts in `prompts.ts`. UI shows inline textarea editor and loading state
- **Auto Node Creation**: When `pendingNewNode` is true (all nodes closed, or user clicked "New task"), the next prompt automatically creates a new node without any modal interaction. `NodeManager.pendingNewNode` state propagated through the full stack

### Changed

- **`DEFAULT_MAX_INJECTED_CHARS` Doubled**: Default recall context limit increased from 200K to 400K chars (~100K tokens), max from 400K to 800K (~200K tokens). Reflects the 1M context window model. `damocles.recallMaxInjectedChars` setting minimum raised from 10K to 200K
- **Node Selection Flow**: Blocking promise-based `resolveNodePicker` pattern removed from `ClaudeSession`. Node selection is now fully non-blocking — the chip sets `activeNodeId` directly via `set-active-node` message, and `sendMessage()` reads it synchronously
- **`runRecallLoop()` Options**: New `forceRepl`, `systemPromptOverride`, and `initialPromptOverride` parameters enable seed context regeneration to reuse the REPL infrastructure with custom prompts
- **`node-state-updated` Message**: Now carries `pendingNewNode` boolean for UI state synchronization
- **`nodeTurnsLoaded` Message**: Now carries `seedContextPrompt` field for display in the overlay

### Removed

- **`NodePickerDialog` Component**: Deleted `src/webview/components/NodePickerDialog.vue` — replaced by `NodeChip`
- **`show-node-picker` Message**: Removed from extension→webview protocol along with `node-selected` and `node-picker-cancelled`
- **`resolveNodePicker` / `getPendingNodePrompt`**: Promise-based blocking pattern removed from `ClaudeSession`
- **Picker State from `useNodeStore`**: `isPickerOpen`, `pickerNodes`, `pickerCanCreateNew`, `pickerPreSelectedNodeId`, `openPicker()`, `cancelPicker()` all removed

## [1.4.1] - 2026-03-16

### Added

- **User-Driven Node Outcome**: Node close prompts and the Session Node Overlay now let the user explicitly select an outcome (Resolved, Partial, Abandoned) via color-coded buttons with icons (`IconCheckCircle` emerald, `IconWarning` amber, `IconXCircle` red). Previously Haiku auto-determined the outcome during summary generation — now the user's choice is authoritative and Haiku generates all other summary fields (title, description, files, decisions, entities)
- **Node Graph Visualization**: Session Node Overlay redesigned from flat active/closed lists to a two-column graph layout — closed nodes on the left, active nodes on the right. Canvas-drawn bezier edges connect active nodes to their related closed nodes. `ResizeObserver` + `drawEdges()` keeps edges responsive with device-pixel-ratio-aware rendering
- **`TaskNodeCard` Component**: Extracted reusable card from `SessionNodeOverlay.vue`. Shows title, status indicator (green dot for active, outcome icons for closed), entity badges (max 5), turn count, age, and action buttons. Active cards have a close popover with outcome selection; closed cards have a reopen button. Top colored stripe reflects status/outcome
- **`useNodeFormatting` Composable**: Shared `formatAge()` and `outcomeBadgeClass()` extracted from `SessionNodeOverlay` for reuse across node UI components
- **`OverlayShell` `noScroll` Prop**: Boolean prop to disable default overflow-y-auto scrolling, used by the graph view which manages its own layout
- **Per-Node Close Loading State**: `closingNodeIds` set in `useNodeStore` tracks which specific nodes are being closed, enabling per-card loading spinners in the graph view

### Changed

- **Abandoned Node Exclusion**: Closed nodes with `abandoned` outcome are now excluded from: (1) node creation context — Haiku no longer sees abandoned nodes when generating titles for new nodes, (2) cross-node entity overlap computation — abandoned nodes won't surface as related nodes
- **`generateNodeSummary()` Signature**: Added required `outcome` parameter before `abortSignal`. Haiku schema no longer includes `outcome` field — the user-provided value is merged into the result
- **`close-node-request` Message**: Now carries `outcome: 'resolved' | 'partial' | 'abandoned'` field
- **`handleNodeClosed()` Accepts `nodeId`**: Webview handlers pass the confirmed `nodeId` for per-node loading state cleanup

## [1.4.0] - 2026-03-15

### Added

- **Task Node System**: User-managed containers that scope conversation turns to specific tasks, eliminating context poisoning in recall mode. Each prompt is assigned to a node via a dialog, and the recall system retrieves context only from the active node's turns with optional summary cards from related closed nodes
- **Node Picker Dialog**: Modal dialog on prompt submit (from the 2nd prompt onward) for selecting which task node to assign the prompt to, or creating a new one. Auto-generates title and key entities via Haiku structured output. Supports up to 5 concurrent active nodes
- **Node Close Prompt**: Inline banner after each response offering to close the active task node. Closing triggers Haiku-powered summary generation with structured fields: title, task description, outcome (resolved/partial/abandoned), files changed, key decisions, and key entities
- **Session Node Overlay**: Dedicated full-screen overlay (top toolbar Layers button) for browsing all session task nodes. List view shows each node's title, status, first prompt (collapsible), key entities, files touched, and last activity. Click any node to drill into the full conversation view — every turn rendered as markdown with collapsible assistant responses, tool calls, thinking blocks, and per-turn file badges. Fully separate from the per-message Context Injection Overlay
- **Node Context Tab**: Per-message Context Injection Overlay gains a "Node Context" tab replacing the old "Nodes" tab. Shows the actual turns injected for that specific prompt as structured conversation cards (user/assistant pairs with markdown rendering, tool calls, file badges) with a Cards/Raw toggle — Raw mode displays the literal `finalContext` string the model received. Node title badge in header
- **Cross-Node `/btw` Search**: `/btw` prompt-prefix mode searches across all nodes (active + closed + orphan turns) for ephemeral cross-cutting questions, bypassing node scoping entirely
- **`NodeManager` Class**: Core node lifecycle management with dependency-injected persistence — create, close, reopen, entity accumulation (two-tier: Haiku-seeded on creation, deterministic extraction on subsequent turns), and cross-node entity overlap computation (40% threshold with `min()` denominator)
- **`haikuStructuredQuery` Utility**: Shared utility for SDK structured output calls to Haiku, used by both node title generation and summary generation. Mirrors the intent-analysis pattern but generic and reusable
- **Node JSONL Persistence**: Four new entry types (`node-created`, `node-closed`, `node-reopened`, `node-state` checkpoint) following the existing event + checkpoint pattern. History builder reconstructs node state from JSONL on session reload
- **`nodeId` on `StructuredTurn`**: Join key connecting turns to nodes. `null` for orphan turns predating the node system. Orphan turns below 4K chars are bulk-assigned to the first created node
- **`useNodeStore` Pinia Store**: Reactive state for nodes, picker dialog, close prompt, and overlay with drill-down detail view (turn loading, selected node). Webview ↔ extension message protocol for `requestNodeTurns` → `nodeTurnsLoaded` on-demand turn data
- **Extension-Side Node Handlers**: Message router handlers for `node-selected`, `new-node-requested`, `node-picker-cancelled`, `close-node-request`, `reopen-node-request`, `requestNodeTurns`
- **Enriched `RecallTrajectory`**: Trajectories now carry `nodeId`, `nodeTitle`, and `contextTurns: NodeTurnDisplay[]` — structured turn data enabling the per-message Node Context tab's card view without a separate request
- **Enriched `TaskNodeDisplay`**: Node state broadcasts now include `firstPrompt`, `filesTouched` (aggregated), and `lastActivity` timestamp for the Session Node Overlay's rich list view

### Removed

- **Graph Pipeline**: The 3-node `StateGraph` (`intentAnalysis` → `recallRepl` → `stateUpdate`) is replaced by a direct `buildNodeContext()` function. All graph engine files (`graph/` directory, `shared/types/graph.ts`) deleted
- **Intent Classification**: The 8-category Haiku intent call (`recall|debug|explain|feature|refactor|test|continuation|general`) is removed — task nodes make it redundant since the user explicitly scopes their work
- **Continuation Detection**: `isContinuationPrompt()` heuristic, `CONTINUATION_WORDS` set, `buildRecentFullContext()`, and the `continuation` intent short-circuit are removed — within a node, "do it" unambiguously means "continue this node's task"
- **Intent-Driven Retrieval Strategy**: `buildIntentGuidance()`, `buildMergedGuidance()`, and the per-intent `<retrieval_strategy>` prompt sections are replaced by a simpler node-scoped `<scope>` section
- **Graph State Persistence**: `persistGraphSnapshotQueued()`, `persistGraphStateQueued()`, `GraphSessionState`, graph snapshot extraction from JSONL — all removed from production code paths
- **`graphStateData` and `graphSnapshots` from `SessionData`**: No longer extracted or used during session reload

### Changed

- **`buildRecallSystemPrompt()` Signature**: Changed from `(userPrompt, turnCount, totalChars, intentContext)` to `(userPrompt, turnCount, totalChars, nodeContext?)` where `nodeContext` is `{ nodeTitle: string } | null`
- **`runRecallLoop()` Options**: `intentContext` parameter replaced with optional `nodeContext`. Loop no longer short-circuits on continuation prompts
- **`RecallService.getContextForInjection()`**: Now routes through `buildNodeContext()` when a node is active, or `buildFlatContext()` when no nodes exist. Both fall back to the REPL loop only when context exceeds `maxInjectedChars`
- **`RecallService.onPromptSubmit()`**: Accepts optional `nodeId` parameter for turn-to-node assignment
- **`TurnPersistence.startTurn()`**: Accepts optional `nodeId` parameter stored in the turn accumulator
- **Context Injection Overlay**: "Nodes" tab replaced by "Node Context" tab showing per-prompt injected turns (Cards/Raw toggle). `NodeDashboard` component decoupled — no longer embedded. `openNodesDashboard()` removed from `useContextInjectionStore`. Tab type changed from `'nodes'` to `'nodeContext'`, new `contextViewMode: 'cards' | 'raw'` state added
- **`BtwHandler`**: New `sendWithContext()` method for cross-node search with recall context injection
- **`buildDirectContext()`**: Now exported from `recall-loop.ts` for use by `buildNodeContext()`

## [1.3.5] - 2026-03-14

### Added

- **`/btw` Side Question Command**: Ask ephemeral side questions that share conversation context without interrupting the main session. Uses `resume` + `forkSession: true` to load conversation history via prompt caching (token-efficient — only the question + response are new tokens). Responses stream in a full-screen `OverlayShell` overlay with markdown rendering, matching the pattern used by subagent and context injection overlays. Side questions are not persisted to session JSONL. Supports concurrent btw queries alongside an active main conversation, 60s timeout, and cancellation. New `BtwHandler` service follows the `SubCallHandler` pattern with independent `AbortController` per query. System prompt matches the CLI's `/btw` implementation exactly. Works as an `immediate` command — intercepted in both `handleSendMessage` and `handleQueueMessage`, so `/btw` can be sent while a response is actively streaming (matches CLI's `immediate: true` behavior). Overlay auto-opens on first streaming delta and can be dismissed at any time; store tracks `isOverlayOpen` state independently from active asides

## [1.3.4] - 2026-03-14

### Added

- **`test` Intent Category**: 8th intent type for the recall classification system. Triggers on test-writing activities ("write tests for X", "add unit tests", "set up the test harness") with specialized retrieval guidance: searches for source-under-test via `filesTouched`, existing test files (patterns: test/spec/**tests**), test execution results from Bash tool calls, and test patterns/utilities in assistant responses
- **`secondaryIntent` Field**: Optional secondary intent captures multi-intent prompts (e.g., "fix the failing test and write more tests" → `debug` + `test`). Threaded through the full pipeline: intent analysis node, graph state, REPL loop, state update, session trace persistence, and deserialization (defaults missing field to `null` for backwards compatibility). Merged retrieval guidance renders as `PRIMARY OBJECTIVE` + `SECONDARY OBJECTIVE` blocks
- **Differentiated Retrieval Strategies**: `feature` and `refactor` intents now have distinct retrieval guidance. Feature guidance searches for related code, similar patterns, and design discussions. Refactor guidance searches for target files, test coverage, usage sites, and prior architectural decisions. Previously both shared a generic `filesTouched` instruction
- **Sharpened Intent Definitions**: All 8 intent categories now include trigger-phrase examples in the classification prompt (previously only `recall` and `continuation` had them), improving Haiku classification accuracy

### Fixed

- **Plan clear-context resets max tokens to 200K**: When exiting plan mode with "Clear Context & Accept", the `sessionCleared` message reset `sessionStats.contextWindowSize` to `DEFAULT_CONTEXT_WINDOW` (200K) but `sendCurrentSettings` only emits a `settingsUpdate` message (no model info). Added `sendModelForPanel` call after `sendCurrentSettings` in the clearContext path to emit a `modelUpdate` message carrying the correct `contextWindowSize`

### Changed

- **Test suite expanded to 350 tests across 17 files**: Was 343. Added tests for `test` intent classification, multi-intent detection (`debug` + `test`), `secondaryIntent` persistence in trace entries, merged retrieval guidance output, and `secondaryIntent` backwards-compatible deserialization
- **Graph State Inspector**: Shows `Secondary: <intent>` badge when secondary intent is present, replacing the removed `Strategy` badge

## [1.3.3] - 2026-03-14

### Added

- **Live Context Injection Overlay**: The overlay now streams live during recall/memory processing instead of requiring a pull after completion. Four new push-based messages: `contextInjectionStarted` (opens overlay with running state), `recallIterationUpdate` (streams REPL iterations as they complete), `recallCompleted` (final trajectory), `memoryInjectionUpdate` (catalog data). Store manages `liveRecallIterations` accumulator and `liveState` (`idle`/`running`/`complete`). Opening the overlay before or during processing shows real-time progress. Auto-selects Graph tab when memory has no data
- **User-Friendly Overlay Mode**: Technical/friendly toggle on the Context Injection Overlay. Friendly mode uses plain language for tab names ("Processing Steps", "Conversation Lookup"), descriptions, and labels. Full i18n support for both English and Greek locales
- **Subagent Tool Result Leak Fix**: Root-cause fix for subagent tool results leaking into the main session JSONL. `hook-handlers.ts` passes SDK's `agent_id` to `ToolManager.handlePostToolUse()`, which derives `parentToolUseId` from `activeSubagents` when `streamedToolIds` doesn't contain the tool (race during parallel agents). `RecallService.onToolResult()` early-returns on `parentToolUseId`
- **Deferred Synthesis Persistence**: When Agent tool_use blocks are pending, `RecallService.persistAssistantData()` defers the synthesis message until all Agent results arrive, ensuring correct JSONL ordering (tool_results before synthesis). `TurnPersistence.persistAssistantQueued()` reordered to write tool results before the assistant message. `flushPendingToolResults()` provides a safety flush at `onResponseComplete()`
- **Agent Result Parsing**: `extractAgentText()` parses Agent tool results (JSON with `content` array) into readable text for recall history. `buildHistoryFromEntries()` gives Agent results 8K char limit (vs 2K for other tools). Agent prompt included as header when available
- **Recall Direct Context Improvements**: `totalChars` calculation now includes tool result lengths for accurate history size estimation. `buildDirectContext()` includes tool results inline with each tool call. REPL loop `onIteration` callback enables live streaming
- **Subagent Leak Tests**: New `subagent-leak.test.ts` with 11 tests across 3 suites — leak reproduction, ToolManager `parentToolUseId` derivation, and JSONL persistence ordering with deferred synthesis

### Fixed

- **AutoCompact context window always 200K**: `ContextMonitor` percentage thresholds were always calculated against 200K regardless of actual model context window. Root cause: `ClaudeSession.currentModelId`/`currentBetas` were never initialized from constructor options (only set on UI-driven model changes), so `reset()` and initial queries always used the 200K default. Additionally, `getContextWindowForModel()` didn't recognize the `[1m]` model suffix. Now constructor initializes both fields and sets the correct context window upfront

### Changed

- **Test suite expanded to 343 tests across 17 files**: Was 332 tests across 16 files. Added `subagent-leak.test.ts` (11 tests)
- **GraphView**: Removed unused `ref` and `watch` imports

## [1.3.2] - 2026-03-14

### Added

- **Model-Aware Context Window**: Context window size is now a model property (`contextWindow` on `ModelInfo`) instead of a hardcoded 200K fallback. `getContextWindowForModel()` computes the effective window from model + betas (200K base, 1M when 1M beta is active). Sent to webview via `modelUpdate` message on model or beta change, updating session stats immediately. `ClaudeSession.setModel()`/`setBetas()` call `contextMonitor.setContextWindowSize()`. All 5 hardcoded `200000` fallbacks replaced with `DEFAULT_CONTEXT_WINDOW` constant. Statusline script default updated to 1M
- **Recall Precision Guidance**: REPL system prompt now includes Example 7 (disambiguation via `llm_query_batched` YES/NO filtering) and `PRECISION MATTERS` instructions in the `recall` intent strategy. Teaches the root model to use conjunctive matching and sub-LLM semantic filtering when keywords match multiple unrelated topics
- **Integration Quality Tests**: New `integration-quality.test.ts` with 13 real-model tests across 4 suites — precision/noise rejection (3), overlapping topic disambiguation (4), Haiku-scored consumer quality (3), and paraphrase robustness (3). New `createOverlappingHistory()` fixture with 100 turns of deliberate cross-topic keyword bleeding
- **Precision Assertions**: Added `precision >= 0.5` assertions to 5 existing integration tests in `integration.test.ts`

### Changed

- **Test suite expanded to 332 tests across 16 files**: Was 299 tests across 14 files. Added `integration-quality.test.ts` (13 tests) and `integration-helpers.ts` (shared helpers extracted from `integration.test.ts`). Cleaned up unused imports across test files, fixed TypeScript type annotations in mocks

## [1.3.1] - 2026-03-14

### Added

- **Session Tagging**: Tag sessions via the session picker for quick categorization. Uses SDK's `tagSession()`/`getSessionInfo()` APIs for persistence. Tag badge shown in session list, searchable by tag, inline input for add/edit/remove. New `sdk-operations.ts` module wraps SDK session APIs with dynamic import
- **1M Context for Opus 4.6**: Extended the 1M context window toggle to support Opus 4.6 in addition to Sonnet 4.6. Uses the SDK's `[1m]` model suffix convention (e.g., `claude-opus-4-6[1m]`) — the SDK auto-adds the header and strips the suffix before the API call. Regex updated in both extension (`modelSupports1MContext()`) and webview (`SettingsPanel.vue`). `setBetas()` now calls `closeAndReset()` so toggling 1M context takes effect immediately
- **Max Effort Level**: Added `'max'` reasoning effort for Opus 4.6 only. `ReasoningEffort` type extended, Opus model config updated with `['low', 'medium', 'high', 'max']`
- **`supportsAutoMode` on ModelInfo**: Forward-compatibility field for SDK's `ModelInfo.supportsAutoMode`. Flows through from `supportedModels()` — no model entries need it set manually

### Fixed

- **`queued_to_running` Agent Status**: When `Agent({resume})` targets a still-running agent, the SDK returns `queued_to_running` status. Extension-side (`tool-manager.ts`) and webview-side (`tool-handlers.ts`) now skip subagent finalization for this status, keeping the subagent in `running` state

### Changed

- **SDK upgraded to v0.2.75**: 1M context window for Opus 4.6, max effort, session tagging APIs, `queued_to_running` agent status, `supportsAutoMode` model capability

## [1.3.0] - 2026-03-14

### Added

- **Recall Graph Pipeline**: LangGraph-inspired stateful graph engine wrapping the recall loop. Custom `StateGraph` class with compile/invoke, typed annotations, and execution snapshots. Three-node pipeline: `intentAnalysis` → `recallRepl` → `stateUpdate`. `RecallService` now builds and invokes the compiled graph instead of calling `runRecallLoop()` directly. Graph state and execution snapshots persisted to JSONL via `TurnPersistence`. Loaded on session resume via `buildSessionData()`
- **Intent-Driven Recall**: Model-classified intent replaces the `isVagueQuery()` length heuristic. `intentAnalysisNode` classifies queries as `recall`, `debug`, `explain`, `feature`, `refactor`, `continuation`, or `general` and extracts key entities. Intent and entities flow into `buildRecallSystemPrompt()` as targeted `<retrieval_strategy>` guidance with per-intent search instructions. `isContinuationPrompt()` word-set heuristic combined with `intent === 'continuation'` for deterministic short-circuit
- **Graph Visualization**: New "Graph" tab in the Context Injection Overlay. `GraphView.vue` renders an SVG-based DAG with animated edges for active transitions. `GraphNode.vue` shows status-aware nodes (pending/running/completed/error/skipped) with pulse animation. `GraphEdge.vue` renders Bezier curves with animated dots. `GraphStateInspector.vue` provides click-to-inspect node input/output state with collapsible JSON views. Live graph updates stream to the webview during recall execution via `graphExecutionUpdate` messages
- **Graph Session State**: `GraphSessionState` tracks cross-prompt execution traces (intent per turn, key entities, recall success). `stateUpdateNode` appends per-prompt trace entries with `recentEntities` as a rolling set of the last 20 entities. State serialized/deserialized to JSONL for session persistence
- **Recall Test Suite**: 297 tests across 14 files covering unit, integration, and graph layers. `vitest.config.ts` with path aliases and VS Code mock. Test fixtures with realistic conversation histories and mock SDK. Coverage: js-repl, parsing, prompts, types, trajectory-manager, recall-loop, golden-retrieval, e2e-pipeline, context-chunking, state-graph, recall-graph-state, session-state, state-update-node, graph-integration

### Changed

- **Vague query detection replaced**: `isVagueQuery()` (60-char length check) replaced by `isContinuationPrompt()` (word-set heuristic matching content-free prompts like "yes", "do it", "go ahead"). Short referential queries with domain keywords now flow through intent classification and the REPL search
- **Recall constants renamed**: `VAGUE_QUERY_MAX_LENGTH` → `SPECIFIC_MESSAGE_MIN_LENGTH`, `VAGUE_MIN_RECENT_TURNS` → `RECENT_CONTEXT_MIN_TURNS`, `VAGUE_MAX_RECENT_TURNS` → `RECENT_CONTEXT_MAX_TURNS`
- **Recall system prompt restructured**: Static retrieval strategy section replaced with intent-driven guidance generated by `buildIntentGuidance()` based on classified intent and extracted entities
- **Context injection message expanded**: `contextInjectionLoaded` now includes `graphData: GraphExecutionSnapshot | null`. Context injection store manages graph snapshot state, live graph updates, and node selection
- **Context Injection Overlay**: Three-tab layout (Graph | Recall | Memory) with `formatDuration` extracted to shared `stringUtils.ts`

## [1.2.6] - 2026-03-12

### Added

- **MCP Elicitation Support**: MCP servers can now request user input via the SDK's `onElicitation` callback. Supports two modes — **form mode** renders JSON Schema-driven fields (string, number, boolean) for structured input, and **URL mode** opens an external browser link for OAuth/redirect flows. Full pipeline: `ElicitationManager` (promise-based resolution with abort signal) → `requestElicitation` message → `ElicitationPrompt.vue` (queue-based UI with Accept/Decline) → `answerElicitation` response. State resets on session clear/cancel
- **Agent Progress Summaries**: Running subagent cards now display real-time progress text from SDK `system:task_progress` stream events (~30s interval). Shows description and summary in an italic text strip below the card header. New `damocles.agentProgressSummaries` setting (default: enabled)
- **TaskCompleted Hook**: New `TaskCompleted` hook handler sends a notification toast when subagent tasks complete
- **Worktree Tool Registration**: `EnterWorktree` and `ExitWorktree` tools added to the `ORCHESTRATION_TOOLS` set for proper tool card rendering and categorization

### Changed

- **SDK upgraded to v0.2.74**: Includes elicitation support, task progress events, worktree tools, and `userInvocable` filtering fixes
- **Reasoning effort levels**: Removed `max` effort level from Opus and Sonnet models — SDK only supports `low`, `medium`, `high`

## [1.2.5] - 2026-03-11

### Improved

- **Context Injection Overlay — scrolling fix, rich rendering, collapsible sections:**
  - **Scroll fix**: Removed nested `overflow-hidden` + `flex-1 min-h-0 overflow-y-auto` containers that created competing scroll regions. All content now flows naturally within `OverlayShell`'s single scroll container, matching every other overlay in the codebase
  - **Markdown rendering**: Model responses now render through `MarkdownRenderer` (headings, lists, bold, inline code) instead of raw `<pre>` blocks
  - **Syntax-highlighted code**: REPL code blocks use `CodeBlock` with Shiki JavaScript highlighting + copy button. REPL output renders as plain text `CodeBlock` (no markdown misparsing). Final context renders through `MarkdownRenderer`
  - **Collapsible sections**: All content areas (model response, code block, REPL output, subcall prompt/response, final context) wrapped in shadcn-vue `Collapsible` with chevron toggles. Subcall prompts default collapsed with 80-char preview; everything else defaults open
  - **No more truncation**: Removed all `.slice(0, 500)` data truncation on subcall prompts/responses and all `max-h-48`/`max-h-64`/`max-h-32` CSS constraints. Full content available via collapsible expand

## [1.2.4] - 2026-03-11

### Improved

- **Recall Loop Retrieval Strategy — turn metadata + prompt improvements for vague/referential queries:**
  - **`filesTouched` turn metadata**: Pre-computed `filesTouched: string[]` array on each `StructuredTurn`, extracted from `file_path` fields in tool call inputs (Read/Edit/Write) at finalization time. Enables efficient file-based filtering in the REPL without iterating through raw `toolCalls` arrays. Computed in both live turns (`TurnPersistence.finalizeTurn()`) and loaded sessions (`HistoryBuilder.flushTurn()`) via shared `extractFilesTouched()` utility
  - **Retrieval strategy section**: New `<retrieval_strategy>` prompt section teaches the recall model to classify queries before searching — vague/referential (recent turns only), specific (keyword + file search), multi-topic (parallel region search via `llm_query_batched`), negation/contrast (find previous approach + current intent), and chained vague prompts (expand window to find the original specific request)
  - **Vague query example** (Example 4): Demonstrates returning last 3 turns directly for queries like "fix it" — no keyword search needed
  - **Multi-topic example** (Example 5): Shows combining recent turns with `filesTouched`-based filtering and batched sub-LLM extraction for queries referencing multiple conversation regions
  - **Chained vague prompts example** (Example 6): Demonstrates backwards expansion to find the first specific request in a chain of vague follow-ups (detects turns with `userMessage.length > 40` or `filesTouched.length > 0`)
  - **Vague query short-circuit**: Prompts ≤60 chars without file paths or extensions (`isVagueQuery()`) deterministically bypass the REPL loop entirely — `buildRecentFullContext()` returns the last 3-5 turns, expanding backwards through any chain of vague messages to find the original specific request that started it. Eliminates 15-30s of model call overhead for prompts like "fix it", "continue", or "yes"
  - **FINAL mechanism consistency**: `FORCED_ANSWER_PROMPT` now instructs the model to use ` ```repl ` blocks for FINAL calls, consistent with how `js-repl.ts` actually detects FINAL via `ExecutionResult` structured fields
  - **Strategy-oriented initial prompt**: `buildInitialPrompt()` now asks the model to assess query type (vague vs specific) before searching, rather than generic "look through the context"
  - **FINAL nudge in continuation prompt**: `buildContinuationPrompt()` explicitly prompts "call FINAL now" when sufficient context is gathered, reducing unnecessary iterations

## [1.2.3] - 2026-03-10

### Fixed

- **Recall Loop Performance — prompt improvements + timeout guardrails:**
  - **Prompt conciseness rules**: Added constraints to recall system prompt — one focused code block per response, under 50 lines, sparing `console.log()` (counts/summaries only, never full file contents), filter-first strategy, and no re-extraction of existing REPL variables
  - **Output scope rules**: Receiving model needs conversation context (what the user asked, what was decided, key outcomes), not full source code — prefer summaries over raw dumps
  - **Continuation prompt with variable summary**: `buildContinuationPrompt()` now includes REPL variable types and sizes via `getVariableSummary()` (e.g., `authTurns: Array(3)`, `combined: string (4521 chars)`), preventing the model from re-extracting data it already has
  - **Total loop timeout (120s)**: Wall-clock timeout across all iterations, matching RLM's `_check_timeout()`. When exceeded, the loop breaks to the forced-answer path with `timedOut: true` in the trajectory
  - **Per-iteration abort timeout (60s)**: Each iteration gets an `AbortController` with `min(remainingTime, 60s)`. On timeout, the iteration is skipped and the loop continues (not immediate forced answer — gives the model another chance)
  - **Forced-answer time guard**: If < 15s remaining after loop exhaustion, skips the forced-answer model call entirely and uses fallback context directly
  - **`timedOut` trajectory field**: Added to `RecallTrajectory` for observability — amber "Timed out" badge shown in the context injection overlay

## [1.2.2] - 2026-03-10

### Fixed

- **Recall Loop Accuracy — 15 structural fixes aligning with the original RLM algorithm:**
  - **Strip fabricated post-code content**: Text generated after `\`\`\`repl`blocks is produced without execution results — structurally invalid data (fabricated output, speculative FINAL).`stripPostCodeContent()` removes it before adding assistant messages to conversation history
  - **Include initial user prompt in message history**: The `messages` array was missing the initial user turn. Subsequent iterations saw assistant-first messages, violating API turn alternation. Now pre-populated with `buildInitialPrompt(userPrompt)` matching RLM's `build_user_prompt(root_prompt)`
  - **RLM-style continuation prompt with question repetition**: Every iteration re-states the original user question via `buildContinuationPrompt()`, matching RLM's pattern. Previously the question only existed in the system prompt
  - **Allow FINAL() inside code blocks**: `FINAL(value)` inside `\`\`\`repl` blocks is now the preferred path — the sandbox evaluates it against real data. Previously the prompt said "NOT inside code blocks"
  - **Scaffold restoration**: `restoreScaffold()` restores `context`, `llm_query`, and other builtins after every code execution, preventing model code from corrupting the sandbox for subsequent iterations. Mirrors RLM's `_restore_scaffold()`
  - **REPL variable listing in feedback**: `getUserVariableNames()` appends available variables to execution feedback, matching RLM's `format_execution_result()`. Shared `SCAFFOLD_NAMES` constant replaces inline builtins in `SHOW_VARS`
  - **Out-of-band FINAL detection**: `FINAL()` / `FINAL_VAR()` results are now captured via structured `ExecutionResult` fields (`finalValue`, `finalVarName`) instead of parsing stdout text. The previous text-based detection failed when FINAL output contained newlines (e.g., multiline conversation context), causing the loop to exhaust all 15 iterations
  - **Inline FINAL detection after code execution**: When the model writes code + `FINAL(...)` as plain text in the same response, the FINAL is now resolved after code execution (variables exist in the REPL). Previously, all post-code text was stripped, causing the model to loop indefinitely. Matches original RLM's `find_final_answer()` operating on the full response
  - **Continuation prompt with finalization cue**: Added "and determine your final output" to the continuation prompt, matching the original RLM's "and determine your answer". Without this, the model interpreted "Your next action:" as requiring more exploration even when it had already found the relevant context
  - **REPL variable persistence via `globalThis` hoisting**: `const`/`let`/`var` declarations inside the async IIFE wrapper were function-scoped and lost after each execution — breaking the fundamental REPL contract. In the original RLM, Python's `exec()` uses a shared namespace where all variables persist. `hoistDeclarations()` appends `try { globalThis[name] = name; } catch {}` for each declaration, making variables available across executions, for `SHOW_VARS()`, `FINAL_VAR()`, and template literal evaluation
  - **FINAL regex semicolon tolerance**: The model writes JavaScript-style `FINAL(...);` with a trailing semicolon, but the regex `/\bFINAL\(…\)\s*$/` required `)` + whitespace + end-of-string. The `;` blocked every match. Added `;?` before `\s*$`
  - **Direct context short-circuit for small histories**: When total history is under `DIRECT_CONTEXT_THRESHOLD` (12K chars), the full context is returned directly via `buildDirectContext()` without running the REPL loop — eliminating 15-30s of model call overhead for small conversations
  - **Multi-turn conversation history in recall loop**: The SDK's `query()` has no `messages` parameter — the `messages` field passed in options was silently ignored. Every iteration, the model only saw the system prompt + latest prompt string, with zero context about prior REPL interactions. This caused identical code to be generated 15 times in a row. Fixed by flattening the full conversation history (prior responses, REPL outputs, continuation prompts) into a single prompt string
  - **Individual code block execution**: The model often writes multiple ` ```repl ` blocks in one response (e.g., 18 blocks declaring `const relevant` in different blocks). These were joined into one string and executed in a single IIFE — two `const` declarations with the same name caused a syntax error before any code ran, producing zero output. Now each block executes in its own IIFE scope, matching real REPL per-cell semantics. Variables persist between blocks via `globalThis` hoisting
  - **Chunked recall context injection**: The SDK's CLI layer hard-truncates each `additionalContext` at 10K chars (`mFq()` in cli.js). Previously recall + memory shared one string — large recall contexts got silently chopped mid-sentence. Now recall output is split into 9K-char chunks across dynamically generated overflow hook entries (each gets its own 10K budget), with memory on a separate entry. Multi-part chunks use `part="N" of="M"` XML attributes. Max total recall context is configurable via `damocles.recallMaxInjectedChars` (default 200K chars ≈ 50K tokens, max 400K ≈ 100K tokens)
- **Recall Loop Role Reframing**: The recall system prompt framed the task as "answering a query" — the model returned bare extracted answers without conversational structure. The main model then rejected the context as nonsensical. Reframed as a context retrieval system: returns relevant conversation turns (user prompts + assistant responses) so the receiving model can formulate its own answer
- **Recall System Prompt XML Tags**: Structured prompt into `<task>`, `<repl_environment>`, `<examples>`, `<output_rules>` sections matching Damocles conventions, improving instruction adherence

## [1.2.1] - 2026-03-10

### Fixed

- **Context Strategy setting not persisting**: `damocles.contextStrategy` was never declared in `package.json` `contributes.configuration`, causing `config.update()` to silently fail. Selecting "recall" wouldn't survive a VS Code restart. Added the missing declaration with enum `["default", "recall"]` and l10n strings

## [1.2.0] - 2026-03-10

### Added

- **Recall Mode**: New context strategy replacing Context Distillation. Instead of Haiku annotation + FTS5/BM25 retrieval, recall mode gives the LLM a JavaScript REPL (Node.js `vm` module sandbox) with the full conversation history loaded as a `context` variable, and lets it programmatically search, filter, and recursively sub-call itself over chunks of the history. Based on the RLM paper (arXiv 2512.24601v2). Key components:
  - `JsRepl` sandbox — `vm.createContext` with restricted globals (blocks `require`, `process`, `fs`, `eval`, `Function`). Variables persist across code blocks within a recall loop run. 10-second per-block timeout
  - `RecallLoop` — iterates up to 15 times calling the root model, which writes ` ```repl ` code blocks executed in the sandbox. Detects `FINAL()` / `FINAL_VAR()` to extract the recalled context. 30-second total timeout with forced-answer fallback
  - `SubCallHandler` — `llm_query()` / `llm_query_batched()` async functions injected into the REPL that route to a cheap model (default Haiku) for one-shot summarization/extraction
  - `TurnPersistence` — structured JSONL turn format capturing user messages, assistant responses, tool calls with full inputs/results, and thinking blocks
  - `HistoryBuilder` — reads JSONL turns into `StructuredTurn[]` for REPL loading. Also provides `isRecallSession()` for session detection via JSONL metadata marker (`"contextStrategy": "recall"`) with head-of-file parsing (reads first 15 lines only)
  - `TrajectoryManager` — captures full REPL trajectory (iterations, code blocks, outputs, sub-calls) for the context injection overlay
  - The REPL loop always runs when there is history — no short-circuit path. On timeout or max iterations, a forced-answer prompt extracts whatever was gathered; if that fails, the last 3 turns are used as fallback
- **Recall Settings**: `damocles.recallSubcallModel` (default `claude-haiku-4-5-20251001`) and `damocles.recallMaxIterations` (default `15`, range 1–30)
- **Third-Party Notices**: `THIRD-PARTY-NOTICES.md` with RLM (MIT) attribution

### Changed

- **Context Strategy**: `"distill"` renamed to `"recall"` throughout — `damocles.contextStrategy` enum, `StoredSession.isRecall`, settings panel dropdowns, session picker tags, and i18n keys
- **Recall Root Model**: Defaults to Sonnet (`claude-sonnet-4-6`) instead of Haiku — the root model must reason about search relevance, which requires a capable model. Sub-calls (`llm_query`) remain Haiku for cost efficiency. `ClaudeSession.setModel()` forwards to `RecallService.setModel()` so the root model follows the user's configured model
- **Context Injection Overlay**: Recall tab replaces Distill tab — shows REPL trajectory with iteration cards, code blocks, REPL output, sub-call details, timing, and final context. Memory tab unchanged
- **RecallService API**: Same lifecycle interface as `ContextDistillationService` (`onPromptSubmit`, `onResponseComplete`, `onToolUse`, `onStreamDelta`, etc.) — drop-in replacement across `claude-session/`, `streaming-manager/`, `chat-panel/`, and `message-router/`
- **Session Detection**: `isRecallSession()` reads the first JSONL entry for a `"contextStrategy": "recall"` marker instead of scanning for `.db` files
- **`setRecallSession`** is async (loads history via `buildHistory()`) unlike the old sync `setDistillSession`

### Removed

- **Context Distillation Module**: Entire `src/extension/context-distillation/` directory (13 files) — `ContextDistillationService`, `ContextDatabase` (FTS5/SQLite), `ContextRetriever` (BM25), `HaikuAnnotationManager`, `EntryCoordinator`, `EntryTracker`, `UIDisplayManager`, prompts, utils, registry
- **Haiku Observer**: `HaikuObserverOverlay.vue`, `useHaikuObserverStore.ts`, `haiku-observer-handlers.ts`, `haiku-observer.ts` types
- **`RetrievalConfidenceTracker`**: `src/extension/shared/retrieval-confidence.ts` — was distill-only
- **Distill Settings**: `damocles.distillTokenBudget`, `damocles.distillReranking`, `damocles.distillQueryDecomposition` removed from `package.json` and settings UI
- **Distill Messages**: `openHaikuLog`, `setDistillTokenBudget`, `requestHaikuActivity`, `haikuObservationStart`, `haikuStreamDelta`, `haikuObservationComplete`, `haikuActivityLoaded` removed from message types

### Fixed

- **Recall Loop Tools Leak**: SDK built-in tools (Read, Write, Bash, etc.) were available in recall loop queries via default tool set. The model used SDK tools instead of writing REPL code blocks, causing wasted iterations and incorrect results. Fixed by using `tools: []` (disables all built-in tools) instead of `allowedTools: []` (only controls auto-approval permissions)
- **Speculative FINAL Skip**: When the model writes code blocks AND `FINAL()` in the same response, the FINAL is speculative (generated before seeing REPL output). Previously accepted immediately — now skipped, REPL output is fed back, and the model writes an informed FINAL after seeing actual results
- **SubCallHandler Empty Responses**: `llm_query()` sub-calls returned empty strings because only `stream_event` deltas were captured. Added `assistant` message event handling (dual-path: `streamText || assistantText`)
- **`<FINAL>` XML Tag Detection**: Models sometimes emit `<FINAL>...</FINAL>` instead of `FINAL(...)`. Added XML tag pattern matching to `detectFinalInModelResponse()`
- **Recall System Prompt**: Rewritten to match original RLM format — removed "natural language" constraint, returns raw context data (file contents, code, exact tool results) instead of narrative summaries. Added `INITIAL_REPL_PROMPT` iteration-0 safeguard from original RLM

## [1.1.49] - 2026-03-09

### Added

- **Client-Side Image Resize**: Images exceeding the SDK's 2000×2000 pixel limit are now automatically resized via Canvas API before upload, preventing CLI crashes on Remote SSH sessions. A JPEG quality cascade (0.85 → 0.30) ensures resized images stay within the 3.9MB base64 budget. GIF frames are re-encoded as PNG. The raw file size limit was raised from 5MB to 20MB since compression now handles oversized files

## [1.1.48] - 2026-03-09

### Changed

- **Tool Metadata Registry**: Replaced the N+1 per-tool if-chain pattern in `normalizeToolResult()`, `handlePostToolUse()`, `collectToolResults()`, and `extractContentFromEntry()` with a single `TOOL_METADATA_REGISTRY` Map. Each tool registers its `extract`, `normalize`, and `hasStructuredResult` functions once — adding a new tool now requires one registry entry instead of touching 5+ locations. The `ToolResultData` interface was simplified from 9 fields to 5 by replacing per-tool metadata types with a generic `rawResult` field
- **History Manager**: `shouldUseToolUseResultAsDisplay` now uses registry-based `hasStructuredResult` checks instead of hardcoded field tests

## [1.1.47] - 2026-03-08

### Added

- **Loop Command (`/loop`)**: Schedule recurring prompts on cron intervals (e.g., `/loop 5m check the deploy`). `LoopJobTracker` manages job lifecycle (active, cancelling, stopped, expired) via `CronCreate` detection and `task_notification` events
- **Loop Jobs Overlay**: View and manage scheduled jobs with status badges, interval labels, and per-job cancellation. Accessible via amber pill in session stats or clock button in the header
- **Cron Tool Visualization**: CronCreate, CronDelete, and CronList tool cards with schedule info, job IDs, and recurring/one-shot badges. Dual-path metadata ensures identical rendering in live and replayed sessions
- **Panel Restore Error Recovery**: `restorePanel` catches initialization failures and shows an error page instead of a broken panel
- **Observation Pagination**: Memory Panel observations now load 20 at a time with scroll-based lazy loading, replacing the previous hard cap of 50

### Changed

- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` 0.2.70 → 0.2.71
- **Loop Job Cancellation**: `cancelLoopJob` uses `CronDelete` instead of `TaskStop`. Cancel messages appear as visible user bubbles via `correlationId` linking

### Fixed

- **Context Usage Overlay**: `/context` and "View Details" showed raw markdown instead of the overlay after SDK 0.2.71. SDK now converts local command messages to assistant messages — replaced dead processor with a `localCommandPending` flag in `assistant-processor`
- **CronDelete Not Updating UI**: Deleting cron jobs left stale entries. Added `CronDelete` handler in `PostToolUse` hook
- **Loop Jobs Indicator Missing**: `PostToolUse` checked `TaskCreate` instead of `CronCreate`, and tracker couldn't parse plain-text responses. Fixed tool name and added regex fallback for job ID extraction

### Removed

- **Dead `local-command-processor`**: SDK no longer emits `system:local_command_output` through the streaming generator
- **Dead `isLocalCommandOutput`**: Checked for a prefix the SDK now strips before delivery
- **Loop Job Run Tracking**: Removed `runCount`, `lastRunAt`, `lastRunStatus` — ephemeral client-side counters with no SDK backing

## [1.1.46] - 2026-03-06

### Added

- **AskUserQuestion Preview & Annotations**: Options in the question prompt now support HTML previews — an eye icon toggle reveals a preview pane below the option list. A per-question notes textarea on the review tab lets users annotate their selections. Preview content and notes are threaded back to the SDK as `annotations` alongside answers. Enabled via `toolConfig.askUserQuestion.previewFormat: 'html'` in query options
- **Fast Mode Toggle (UI)**: Bolt icon button in the chat input bar for toggling fast mode (same model, faster output). Full extension wiring from webview → settings → `QueryManager` → SDK `settings.fastMode`, with `FastModeState` tracking (`off`/`cooldown`/`on`) from both `system.init` and `result` stream events. Currently shows a toast explaining the limitation — the SDK's native streaming binary only ships with the Bun-compiled CLI, not the npm package used by Node.js extensions. UI ready for immediate re-enablement when the constraint is resolved
- **Hook Agent Logging**: `PreToolUse` and `PostToolUse` hooks now log `agent_id` and `agent_type` fields when tool calls originate from subagents, improving debugging visibility for nested agent workflows
- **ToolSearch Tool Card**: Full visualization for the SDK's `ToolSearch` tool — compact card with search icon shows query and match count (e.g., "3 of 31 tools loaded"), expanded overlay displays query input, max results, matched tool names as pills, and pending MCP servers. History replay via `shouldUseToolUseResultAsDisplay` recognition and metadata extraction through `collectToolResults`. Auto-approved as a read-only tool

### Changed

- **SDK Upgrade**: `@anthropic-ai/claude-agent-sdk` upgraded from `0.2.68` to `0.2.70`
- **YOLO Mode Icon**: Changed from bolt (⚡) to lock-open icon, giving YOLO mode a distinct visual identity separate from the new Fast Mode bolt icon
- **Switch Track Color**: Unchecked switch components now use a theme-derived `switch-track` color (`color-mix` of foreground 20% over background) instead of the default `bg-input`, improving visibility in both light and dark themes

### Fixed

- **QueryManager Stale Query Race Condition**: Added `this._currentQuery !== result` guards after `accountInfo()` and `supportedModels()` promise resolution, and after the `postQueryCreatedHook` call, preventing stale query objects from sending messages or updating state after `closeAndReset()` has already created a new query. Also captured `abortController` locally before the async gap to prevent signal misrouting
- **History Replay User Message Leak**: `extractDisplayableUserContent` now returns null for entries containing `tool_result` blocks, preventing SDK-generated "Tool loaded." notification text from rendering as a user message bubble during session replay

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

[1.8.14]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.13...v1.8.14
[1.8.13]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.12...v1.8.13
[1.8.12]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.11...v1.8.12
[1.8.11]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.10...v1.8.11
[1.8.10]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.9...v1.8.10
[1.8.9]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.8...v1.8.9
[1.8.8]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.7...v1.8.8
[1.8.7]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.6...v1.8.7
[1.8.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.5...v1.8.6
[1.8.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.4...v1.8.5
[1.8.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.3...v1.8.4
[1.8.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.2...v1.8.3
[1.8.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.7...v1.8.0
[1.7.7]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.6...v1.7.7
[1.7.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.5...v1.7.6
[1.7.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.4...v1.7.5
[1.7.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.3...v1.7.4
[1.7.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.6.2...v1.7.0
[1.6.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.18...v1.5.0
[1.4.18]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.17...v1.4.18
[1.4.17]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.16...v1.4.17
[1.4.16]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.15...v1.4.16
[1.4.15]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.14...v1.4.15
[1.4.14]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.13...v1.4.14
[1.4.13]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.12...v1.4.13
[1.4.12]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.11...v1.4.12
[1.4.11]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.10...v1.4.11
[1.4.10]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.9...v1.4.10
[1.4.9]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.8...v1.4.9
[1.4.8]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.7...v1.4.8
[1.4.7]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.6...v1.4.7
[1.4.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.5...v1.4.6
[1.4.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.4...v1.4.5
[1.4.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.3...v1.4.4
[1.4.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.5...v1.4.0
[1.3.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.6...v1.3.0
[1.2.6]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/AizenvoltPrime/damocles/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.49...v1.2.0
[1.1.49]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.48...v1.1.49
[1.1.48]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.47...v1.1.48
[1.1.47]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.46...v1.1.47
[1.1.46]: https://github.com/AizenvoltPrime/damocles/compare/v1.1.45...v1.1.46
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
