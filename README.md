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

- **Chat Interface**: Integrated chat panel for conversing with the model — available as a secondary sidebar view (right side) or an editor panel (`Ctrl+Shift+U`). Both modes support all features and can run simultaneously with independent sessions
- **Collapsible User Messages**: Long user-message bubbles collapse by default (canvas and pinned sticky header alike) with a chevron toggle. Expansion state follows the message across inline↔pinned transitions. Drag the handle below an expanded bubble to set the scroll-cap height — the value becomes the global default and persists across webview reloads. The pinned sticky header can also be hidden entirely via the `×` button; when hidden, a small floating pin chip at the top-right of the chat expands on hover to preview the active pinned message and click-to-restore. Hidden state persists globally via `damocles.pinnedHeaderHidden`. Queued / injected messages (sent mid-stream) are skipped by the sticky header and never pin
- **Code Assistance**: Get help with coding, debugging, refactoring, and more
- **Syntax Highlighting**: Shiki-powered code blocks with VS Code-quality highlighting and one-click copy
- **Diff Approval**: Review and approve file changes with syntax-highlighted unified diffs (supports concurrent diffs)
- **Inline Diff Preview**: Edit/Write tool results show inline diff previews with click-to-expand full-panel view
- **Tool Visualization**: See what tools the agent is using in real-time with expandable details. Each completed tool card shows a subtle duration badge (`123ms` / `1.2s` / `1m 23s`)
- **Tool Overlays**: Click tool cards to view full output in a full-screen overlay — supports built-in tools (Bash, PowerShell, Read, Grep, Glob, WebFetch, WebSearch, CodeSearch, ToolSearch, CronCreate, CronDelete, CronList) with syntax highlighting or markdown rendering, and MCP tools with markdown output and image rendering (base64 image blocks displayed as thumbnails with click-to-enlarge lightbox). Read overlays show a file metadata card with line range, total lines, and a progress bar for partial reads. Cron tool overlays show human-readable schedules, job IDs, recurring/one-shot badges, and job lists
- **Subagent Visualization**: Nested view of `Agent` tool calls showing agent type, model, tool calls, results, and real-time progress summaries. Click the agent type or template badge to open its `.md` template. Background agents display a "Background" badge
- **Background Tasks**: Track background agent tasks _and_ `run_in_background` Bash shells (e.g. "run `sleep 300` in the background") with a dedicated overlay showing status, elapsed time, progress summaries, token/tool stats, and stop/dismiss actions. Results appear as labeled assistant messages. Indicator pill in session stats shows active task count- **Streaming Responses**: Watch responses as they're generated
- **@ Mentions**: Type `@` to reference workspace files or agents (`@agent-Explore`, etc.) with fuzzy search autocomplete
- **Custom Agents**: Define custom agents in `.pi/agents/*.md` or `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user). They run as native nested agents via the `Agent` / `GetSubagentResult` / `SteerSubagent` tools, alongside the built-in `general-purpose` / `Explore` / `Plan` agents; a `run_in_background: true` frontmatter default makes a template always spawn in the background
- **Voice Input**: Three modes via `damocles.voice.mode`:
  - **`off`** — voice disabled, mic button hidden.
  - **`push-to-talk`** (cloud STT) — click the microphone in the chat input to dictate messages. Supports OpenAI Whisper, Deepgram, and Google Cloud STT. Audio is recorded extension-side using native platform APIs (Windows/macOS/Linux) and transcribed via your configured provider. Configure provider, API key, and language in the settings panel.
  - **`wake-word`** (local Jarvis) — hands-free. Say *"Hey Jarvis, …"* and Damocles transcribes once you stop speaking; optionally speaks the assistant's reply aloud. A Python sidecar runs OpenWakeWord + Silero VAD + Parakeet TDT 0.6B v2 ASR + optional VibeVoice-Realtime TTS. **Fully on-device — no audio bytes or transcript text ever leave your machine.** Wake phrase is stripped before transcription via a two-layer defense (ASR offset + regex). VRAM ~3.7 GB with TTS, ~2.2 GB without; CPU fallback automatic. On Linux/macOS the installer surfaces actionable per-distro commands if a C++ toolchain or PortAudio is missing (`apt install build-essential libportaudio2` on Debian/Ubuntu/WSL, `brew install portaudio` on macOS, etc.); on WSL2 with a CUDA GPU it falls back to `/usr/lib/wsl/lib/nvidia-smi` for driver detection. Full guide: [`docs/voice-jarvis-mode.md`](docs/voice-jarvis-mode.md).

  **Note:** Requires local audio hardware — not available when connected to a remote host via SSH (the extension host runs server-side where no microphone is present).
- **Image Attachments**: Paste images from clipboard directly into chat (supports PNG, JPEG, GIF, WebP up to 5MB)
- **IDE Context**: Automatically include the active file or selected code in your message (toggleable in input bar); a workspace default (`damocles.ideContext.enabled`) controls whether the chip starts on in new panels
- **Slash Commands**: Type `/` for built-in commands (`/clear`, `/compact`, `/rewind`, `/btw`, etc.) and custom commands from `.claude/commands/` and `.codex/prompts/`
- **Prompt History**: Navigate previous prompts with arrow keys (shell-style)
- **Prompt Navigator**: `Ctrl+K` / `Cmd+K` opens a searchable overlay listing every user prompt in the active session. Each row shows index, time, tools invoked during the response, and a kebab menu with Copy / Use as draft / Rewind to here. Type to fuzzy-match prompt text or tool names; arrow keys navigate, Enter jumps to the bubble in the canvas (with a primary-color flash ring), Escape closes. The header chip shows live prompt count plus the platform-correct keybind (`⌘K` on macOS, `Ctrl+K` elsewhere). Each user bubble also exposes the same actions via a hover-revealed kebab so mid-canvas navigation never requires the overlay
- **Session Management**: Create, rename, tag, resume, delete, and search sessions with confirmation. Names/tags persist as in-tree session markers; tags show as badges in the session picker
- **Panel Persistence**: Panels and active sessions survive VS Code restarts
- **Multi-Panel Sync**: Prompt history syncs across all open panels instantly
- **Context Stats**: Live tracking of token usage, cache activity, context window %, and session cost — context % reflects the current turn's occupancy (the latest assistant message's input + cache). "View Details" button opens the Context Usage Overlay — a full-screen view with SVG ring chart, stacked category bar, per-category breakdown, collapsible message breakdown (user/assistant/tool calls/results/attachments with per-type drilldowns), detail sections for MCP tools, memory files, agents, system prompt sections, system tools, deferred tools, skills, and slash commands, auto-compact threshold badge, and API usage footer. Also accessible via `/context`
- **Session Logs**: Quick access button to open the raw JSONL session file (also works for subagent logs)
- **Model Selection**: Switch between Anthropic models (Opus 4.8, Sonnet 4.6, Haiku 4.5), OpenAI Codex models (`gpt-5.5` — recommended default, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`), and custom-provider models (StepFun **Step 3.7 Flash**, **DeepSeek V4 Pro / V4 Flash**) from one unified dropdown. All Codex models work via ChatGPT subscription or API key. Per-panel selection plus a workspace-wide default for new panels
- **OpenAI / GPT Backend**: GPT models run natively alongside Anthropic models — two pi-owned auth paths (credentials in its Damocles-owned `auth.json`): ChatGPT/Codex OAuth and `OPENAI_API_KEY`. Codex wins when both are set; `damocles.openai.preferApiKey` inverts it. Per-panel selection with a workspace default; backend-aware cost display (`Input | Cached Input | Output | Reasoning`) with configurable per-model pricing
- **StepFun / DeepSeek Backends**: StepFun (Step 3.7 Flash, step-plan flat-fee subscription) and DeepSeek (V4 Pro / V4 Flash, per-token metered) run natively as main-dropdown models. Each has a dedicated API-key panel in Settings; keys live in SecretStorage and reach pi via the native custom-provider path (no reload). Selecting an unauthed model emits a "Sign in to {provider}" toast. The StepFun key is shared with the Explore StepFun provider — one source of truth, kept in sync across both UIs. DeepSeek is dollar-budget-enforced like other metered providers; StepFun's flat subscription is exempt
- **Adaptive Thinking (per-panel)**: Model-aware thinking configuration driven by model-reported capabilities — adaptive models use configurable reasoning effort (Low/Medium/High/Max, plus xhigh and Ultracode for Opus 4.8), legacy models use the classic toggle + token budget (1K-64K). **Ultracode** is the top reasoning-effort level (maximum thinking); selectable per-panel or as a default for new panels (listed after Max), and applies only to Anthropic Opus 4.8 (not applied to OpenAI/Codex models). Each panel has independent reasoning state: a `thinkingDisabled` flag plus a per-(panel, model) matrix of effort and max-tokens, so switching models within a panel preserves prior intent — flip back to a previously-configured model and its effort/tokens restore automatically. Settings panel splits into four sections (`This Panel` / `Defaults for New Panels` / `Workspace` / `Voice`); the panel and defaults reasoning blocks track different model dimensions independently — switching the active model in the panel section never drags the defaults section's effort capabilities along with it. Workspace defaults persisted via `damocles.thinkingDisabled` / `damocles.effortByModel` / `damocles.maxThinkingTokens`. Thinking blocks always visible (`display: 'summarized'` overrides Opus 4.8's `omitted` default)
- **Per-Panel Permission Mode**: Each panel can have its own permission mode independent of the global default
- **YOLO Mode**: Toggle to auto-approve all tool calls (except plan approval and questions). Ephemeral per-panel setting that resets on session clear; a workspace default (`damocles.dangerouslySkipPermissions`) seeds it for new panels.
- **Custom Permission Rules**: Define persistent allow/deny rules for tools in Claude Code CLI-compatible settings files. Rules support pattern matching (e.g., `Bash(git:*)`, `Edit(*.ts)`). Permission prompts include "Always allow" and "Always deny" options that save rules to your chosen settings file.
- **Hooks**: Run your own command at key moments — before/after a tool, on prompt submit, on completion, or when the agent is waiting for approval — via a config-driven `.damocles/hooks.json`. The contract is Damocles' own: the child gets one JSON object on stdin (snake_case keys, a uniform tool schema) and replies with one JSON object on stdout (`{"decision":"deny"}` to block — a non-zero exit never blocks). A `tool_call` hook can block, force-allow, or rewrite a tool call; activation is by presence (no toggle), gated by workspace trust, and every block/force-allow is logged and surfaced in chat. Full guide: [`docs/hooks.md`](docs/hooks.md).
- **Subagent-Scoped Accept All**: When you click "Accept all edits" on a subagent's permission prompt, only that subagent is auto-approved—the global session mode stays unchanged. Each subagent can be independently auto-approved without affecting the main session or other subagents.
- **Plan Mode**: When enabled, the agent creates implementation plans for your approval before making changes. Review plans in a modal, approve with auto-accept or manual mode, or request revisions with feedback. Dismissing the overlay (Escape) hides it without canceling — click the tool card to reopen, or press Escape again to reject. While planning, the agent writes and continuously maintains its plan as markdown at a deterministic per-session path (`~/.damocles/plans/<slug>-<id8>.md`) — the only native write permitted in plan mode (Bash/PowerShell and every other Edit/Write stay blocked). Enabled MCP tools remain fully available while planning, so the agent can still look things up (e.g. Context7 docs) — the per-server enable/disable toggle is the control. That file is the single source of truth: the approval overlay, the saved plan, and the implementation handoff all read the full plan from it (approval is blocked until the plan file is written), and the completed plan card's **View plan** button opens it. View the session plan anytime via the header button. Plan mode also deterministically funnels every turn through `ExitPlanMode`: if the agent stops without exiting, it is automatically nudged to call `ExitPlanMode`, ask via `AskUserQuestion`, or keep planning — so a plan turn never ends silently without your approval (press Stop or leave plan mode to break out)
- **Clear Context & Auto-Accept**: Plan approval option that clears conversation context and starts fresh with the plan injected (matches Claude Code CLI behavior). Preserves planning session as reference while implementation runs in a clean session. The overlay header shows a context usage badge with threshold-based colors so you can make an informed decision
- **Bind Plan to Session**: Inject a custom plan file into the session via the link icon in the header. It writes the plan to the session's deterministic plan-file path (overwriting an existing one in place) and confirms with a toast — no agent turn is spent. The agent reads the plan from that path, which is injected into the system prompt every turn.
- **File Checkpointing & Session Forking**: Track file changes and rewind to any previous state, or fork the conversation into a new panel without touching the source. Three entry points — the Rewind Browser (`/rewind`), the inline rewind button on any user message bubble (hover to reveal), or `Escape Escape`. The Restore Options modal offers three actions: **Fork conversation** (new panel branched at the selected message; source untouched), **Roll back files** (restore the workspace; conversation stays linear), and **Fork and roll back files** (both). The "files affected" list is the **live diff** between the workspace now and the checkpoint, so files you deleted since are flagged for restore; clicking a file opens a VS Code side-by-side diff. This is backed by a per-session shadow git repo, kept entirely separate from your real repo — a hard restore recreates deleted files and drops ones created after. Forked panels inherit the source's settings, hydrate history up to the fork point, and pre-fill the rewound prompt
- **Rewind to Before Compaction**: After a conversation is compacted, recover the full pre-compaction context. The compaction boundary card carries a **Rewind to before compaction** action, and compaction points also appear in the Rewind Browser (`/rewind`) alongside prompt anchors. Selecting one branches the session at the compaction's parent and opens a forked panel replaying the complete, un-summarized conversation — conversation-only (no file restore), source untouched. Works for manual (`/compact`) and automatic compaction, on live and resumed sessions. A confirmation notes that turns taken after the compaction aren't carried over and that the restored (large) context may re-trigger auto-compaction
- **Side Questions (`/btw`)**: Ask ephemeral side questions that share conversation context without interrupting the main session. Token-efficient via prompt caching — only the question and response are new tokens. Responses appear in dismissable inline aside bubbles with markdown rendering, visually distinct from the main conversation. Not persisted to session history
- **Task List**: Visual display of the agent's current tasks with status tracking, dependencies (`blockedBy`), and active form indicators
- **Message Queue**: Send messages while the agent is working - they're injected at the next tool boundary
- **Manual Compaction (`/compact`)**: Summarize the conversation on demand to reclaim context, optionally focusing the summary with an instruction (`/compact <instructions>`). Gated to idle — finish or stop the current turn first. The compaction boundary and restored context surface inline in the chat
- **Auto-Compact**: Optional automatic context compaction (`damocles.autoCompact`; opt-in, disabled by default). Triggers a compaction once context usage crosses `triggerPercent` of the window to prevent overflow. Applies uniformly to every provider — GPT sessions compact only when you enable it, same as Anthropic
- **Persistent Memory**: Every memory has a **kind** (`fact`, `preference`, `observation`, `note`, `episode`) and a **scope** (`session`, `project`, `global`), stored in WASM-based SQLite (`~/.damocles/memory.v2.db`). No native modules — works cross-platform without compilation. Memories survive compactions and sessions, giving the agent continuity across conversations. Uses a **pull-first catalog model**: each prompt receives a compact relevance-ranked catalog (~300-800 tokens) of available memories, and the agent retrieves full details on demand via `get_memory_details`. This matches how CLAUDE.md works — a reference the agent consults selectively — and eliminates token displacement from irrelevant auto-injection
- **Automatic Memory Extraction**: After a conversation goes idle (or on session switch), a background pass extracts durable facts, preferences, and episodes from the turns — deduping exact and near-duplicate content, resolving contradictions, and decaying time-bound episodes (~30-day TTL, promoted when reused) — so memory accrues without manual `/remember`. Runs on a cheap model; crash-safe (a batch is never lost mid-extraction). Gated by `damocles.memory.autoExtract.enabled`
- **Fact Graph & Versioning**: Facts evolve through `UPDATES` / `EXTENDS` / `DERIVES` / `SUPERSEDES` edges. When a fact is updated the old version is retained (not deleted) and browsable via `get_memory_history`; `get_related_memories` traverses the graph. `forget_memory` drops a memory by id or content — by default forgetting the entire version chain so an older version cannot resurface
- **User Profile**: A short auto-maintained summary of you — a static section plus a recent-activity dynamic section, per project and global scope — regenerated during consolidation and injected once at the start of each session. Edit it inline in the Memory Panel; budget via `damocles.memory.profile.tokenBudget`
- **Pinned Memories**: User-designated memories that are always injected in full content, bypassing the catalog. Pin/unpin via the overlay UI. Configurable budget (default 500 tokens)
- **Retrieval Tracking**: When the agent calls `get_memory_details`, retrievals are recorded and fed back into catalog ranking. Memories the agent actively uses rank higher in future catalogs — a closed feedback loop
- **Observation Staleness**: When source files referenced by an observation are modified, the observation is automatically marked stale. The agent sees `[stale]` tags in context and can verify whether the observation is still accurate, then mark it fresh via the `reset_observation_staleness` MCP tool
- **Memory Commands**: `/remember <text>` saves session memory (prefix `project:` or `global:` for broader scope), `/note <text>` saves to a searchable knowledge base, `/memories` opens the management panel
- **Observations**: The agent voluntarily records rich observations via MCP tool after significant work — structured entries with type, title, narrative, facts, tags, and file paths. Zero additional API cost
- **Memory MCP Tools**: 10 in-process tools for the agent: `save_memory`, `save_observation`, `search_memories` (semantically reranked), `get_memory_details`, `get_memory_history`, `get_related_memories`, `forget_memory`, `save_note`, `list_notes`, `reset_observation_staleness`. Progressive disclosure keeps token usage efficient
- **Smart Session Handoff**: New sessions automatically receive the previous session's summary and top-ranked observations from recent sessions, weighted by file proximity to the active editor
- **Memory Panel**: Full-screen overlay for browsing, creating, deleting, pinning/unpinning, forgetting, and searching memories — with kind/scope filter chips, a forgotten toggle, version-history and related-memories dialogs, and an inline editor for the auto-maintained user profile. Pinned memories show an amber left-border accent
- **Consolidation Panel**: A header pill beside the prompt navigator opens a live view of the consolidation pipeline — a five-phase stepper (Claim → Extract → Persist → Maintain → Profiles) with honest progress (indeterminate sweep for the slow Extract LLM call, a determinate `x/y` counter for Persist), the conversation turns queued for the next pass, and the last pass's extracted memories with outcome badges, an Auto/Manual trigger chip, and a relative timestamp. A failed pass shows a distinct failure card with **Retry now** (and **Sign in to a model** when no extraction model is authed), separate from the neutral "nothing new to remember" state; failures also surface as an error dot on the toolbar icon while the overlay is closed. A **Run now** button triggers consolidation manually. Memory extraction runs on your Settings → Explore model (falling back to the provider-matched small/fast model)
- **Injected-Context Viewer**: Each user message has a "View context" pill that opens an overlay showing exactly what was provided to the model for that prompt — a **Memory** tab lists the injected memories with per-entry relevance scores and the FTS query used, so you can see why each memory surfaced
- **Collaborative Teams**: Multi-agent team system where 2-5 specialist agents collaborate in real-time on complex tasks. A lead agent orchestrates — spawning specialists with domain expertise profiles, coordinating via direct messaging, sharing decisions on a scratchpad, and synthesizing a final result. Provider-agnostic: the lead and specialists run on the active panel's provider, so Claude and GPT teams both work. 172 bundled agent profiles across 14 categories (Engineering, Design, Game Development, Security, etc.) give specialists genuine domain knowledge. TeamCard in chat shows live status; TeamOverlay provides full details (Agents, Timeline, Scratchpad, Result tabs). All agent communication persisted to JSONL. Each Damocles panel owns its own team runner, so multiple panels can run independent teams concurrently without cross-interference. Disabled by default; enable via `damocles.team.enabled`
- **Compass — Workspace Knowledge Graph**: Converts your workspace into a persistent, queryable knowledge graph via tree-sitter AST extraction across 15 languages (Python, JS/TS/TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, **Vue SFC**). Backed by SQLite (sql.js-fts5) — the graph survives VS Code restarts with zero re-indexing. The agent queries the graph via 8 MCP tools: **core** (`compass_search`, `compass_query`, `compass_context`, `compass_stats`), **impact** (`compass_blast_radius`, `compass_review_context`), **analysis** (`compass_dead_code`), and **admin** (`compass_build`). `compass_review_context` auto-detects changed files via git when no file list is provided. Every `compass_query` response states what the target resolved to (name, kind, `path:line`), lists alternate matches on ambiguity, and flags empty relationship results for verification — so a "none" is diagnosable rather than silently wrong. Key capabilities: FTS5 BM25 search with camelCase/snake_case tokenization (plus parent-class and directory tokens, so a query naming a class surfaces its methods), blast radius analysis (BFS from changed files through all edge kinds, bounded non-lossily on hub nodes), risk-scored review context (flow-criticality-weighted impact + test gaps + affected flows, with a context-savings estimate), test-coverage edges (`tests_for` / test-gap risk, derived from tests that call production code — recognizing Rust `#[test]`, PHPUnit camelCase, and `@Test`/`[Fact]`-family annotations, with a class-name fallback for DI-heavy tests), dead-code detection (unreferenced functions/classes, excluding entry points and framework-managed classes; constructor/static calls and type-hint/DI-injected dependencies are now tracked across all languages, so constructor-injected services aren't false-flagged), execution flow tracing with criticality scoring (framework decorators and entry-name conventions across 15+ stacks; test files excluded from production flows), and Louvain community detection (adaptive resolution scales inversely with graph size; directory-based fallback above 20K nodes). Interactive D3 force-directed graph visualization in the webview with community coloring, blast radius overlay, and click-to-navigate. VS Code sidebar tree view, search panel, validation panel (broken edges, orphans, stale files), editor gutter decorations for blast radius, and status bar. Incremental updates are watcher-fed — newly created files are indexed within seconds without a rebuild (large bursts like branch switches fall back to one git diff) — with SHA-256 caching, transitive dependent invalidation, and disk writes only when the graph actually changed. Resilient by design: a corrupt graph cache self-heals on startup, and repeated worker crashes trip a circuit breaker ("Compass failed — run Rebuild to retry") instead of looping. Works correctly on Windows (drive-letter casing, `/`-style `excludePatterns`) and in monorepos where the workspace is a subfolder of the git repo. All tools support `detail_level` (minimal/summary/full) for token efficiency. Disabled by default; enable via `damocles.compass.enabled`
- **Damocles Browser**: Integrated browser with full CDP automation — launches a headless Chromium inside a VS Code editor panel with toolbar (back, forward, reload, URL bar, element picker, DevTools). The agent gets 15 MCP tools (`browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_query`, etc.) for full page interaction. Element picker lets users select elements and attach DOM/CSS/screenshot context to chat messages. Multi-page session tracking via CDP `Target.setAutoAttach` for popup-spawned pages — they attach, take focus on spawn, and the screencast restores to the parent page when the popup closes; background-spawned pages stay attached but don't steal the panel. Zero external dependencies — CDP commands route through a raw WebSocket. Disabled by default; enable from the MCP status panel toggle or via `damocles.browser.enabled`. **Known limitation:** popup-based "Sign in with Google" / Apple / Microsoft (`window.open()` flows including Google Identity Services) does *not* complete inside the panel — Chromium's `--headless=new` flag does not allocate paint surfaces to popup windows ([Chromium 696439](https://crbug.com/696439)), so the popup attaches but never renders and there's nothing for the user to click. Same-window OAuth that redirects the parent page (e.g., Wizards SSO) is unaffected. For popup-based providers, sign in via your normal browser before bringing the URL into the panel.
- **MCP Elicitation**: MCP servers can request user input during tool execution — form mode renders JSON Schema-driven fields for structured input, URL mode opens an external browser for OAuth flows. Prompts appear above the chat input with Accept/Decline actions
- **MCP Server Management**: The MCP client is **native** — servers come from workspace `.mcp.json` merged over a read-only import of your existing Claude Code / Claude Desktop config (imported entries show a "From Claude Code" badge), connect over stdio or streamable-HTTP, expose each tool as `mcp__{server}__{tool}`, and authenticate via OAuth (PKCE) where required. Enabled servers are **supervised**: they stay connected for the session and auto-reconnect when a connection drops (detected via the SDK's `onclose`), with a crash-loop throttle and config-change re-validation so a reconnect never resurrects an orphaned child process — opt out per server with `lifecycle: "lazy"` (connect-on-use) or an explicit `idleTimeout`. Enable/disable servers from the UI with the disabled set persisted to Damocles workspace state (`damocles.mcp.disabledServers`); the whole subsystem toggles via `damocles.mcp.enabled`. Status panel shows per-server tool counts with expandable details and annotation badges (read-only, destructive, network), error messages for failed servers, and reconnect/authenticate actions
- **Web Tools** _(opt-in)_: Three native, **key-free** tools backed by Exa's free endpoint — **WebSearch** (an answer with cited sources), **WebFetch** (read a web page or PDF as markdown), and **CodeSearch** (search public source code and docs). No API key or config required. WebFetch extracts HTML via Readability, reads PDFs inline, and falls back to the `r.jina.ai` reader for JavaScript-heavy pages; fetched URLs are validated to block internal/loopback/cloud-metadata addresses. All three are read-only — available in plan mode and inherited by `tools: *` subagents. Enable via `damocles.pi.webSearch.enabled`; the toggle takes effect on the next turn with no install or reload
- **Hooks Support**: Claude Code hooks (shell commands that run on events like tool calls) work automatically
- **Tools Panel**: A status panel listing every agent tool grouped by subsystem (core, memory, compass, browser, web), each with a per-tool enable switch and a per-subsystem master switch. Core built-ins are locked on; memory/compass/browser/web tools toggle. Opens from the tools indicator in session stats
- **Skills Support**: Approve or deny skill invocations. Skills are discovered from your Damocles dirs (project + user `.claude/skills/` and `.codex/skills/`) and merged into the slash-command list alongside the built-in commands. When a skill or command name exists in both sources, `damocles.assetSourcePrecedence` decides which wins
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
- `Ctrl+K` / `Cmd+K`: Toggle the Prompt Navigator overlay
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

Attached images appear as compact chips (icon + filename + WIDTH×HEIGHT) below the input. Hover over a chip to reveal the remove button. Click any image in the conversation to open it in a lightbox.

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

Custom agents are loaded from `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user). Project agents override user agents with the same name.

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
| `/init`            | Initialize CLAUDE.md                                                   |
| `/remember <text>` | Save session memory (`project:` or `global:` prefix for broader scope) |
| `/note <text>`     | Save a persistent note to the knowledge base                           |
| `/memories`        | Open the memory management panel                                       |
| `/context`         | Display context usage breakdown                                        |

Custom commands are loaded from `.claude/commands/*.md` and `.codex/prompts/*.md` (project) plus their `~/` user equivalents. Within a source, project overrides user; across sources, `damocles.assetSourcePrecedence` (default `claude`) decides which wins on a name collision.

### Skills

Skills are specialized tools that extend the agent's capabilities. You can invoke skills in two ways:

**Via slash command (recommended):**

- Type `/skill-name` to invoke a skill directly - it appears in the autocomplete popup alongside regular commands
- Skills invoked this way are **auto-approved** (no approval prompt)
- Pass arguments after the skill name: `/skill-name additional context here`

**Via the agent's autonomous invocation:**

When the agent decides to use a skill on its own, you'll see an approval prompt:

- **Yes**: Approve this invocation (manual mode)
- **Yes, don't ask again**: Auto-approve this skill for the session
- **No**: Deny the skill
- **Tell Damocles what to do instead**: Provide custom feedback

Skills are loaded from `.claude/skills/<name>/SKILL.md` and `.codex/skills/<name>/SKILL.md` (project) plus their `~/` user equivalents, with the same precedence rules as commands. The skill description is parsed from the YAML frontmatter.

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
    "allow": ["Bash(git:*)", "Bash(npm run *)", "PowerShell(Get-ChildItem:*)"],
    "deny": ["Bash(rm:*)", "Bash(sudo:*)", "PowerShell(Remove-Item:*)"],
    "ask": ["Bash(npm publish:*)"]
  }
}
```

`Bash` and `PowerShell` rules are evaluated independently — a `Bash(git:*)` rule does not auto-allow a `PowerShell git status` call. Cross-shell isolation is intentional: PowerShell flag semantics and sandboxing differ from Bash on Windows, so users who want both must write both rules explicitly.

**Pattern syntax:**

| Pattern                       | Matches                                |
| ----------------------------- | -------------------------------------- |
| `Bash`                        | All Bash commands                      |
| `Bash(git:*)`                 | Bash commands starting with `git`      |
| `Bash(npm run *)`             | Bash commands starting with `npm run ` |
| `PowerShell`                  | All PowerShell commands                |
| `PowerShell(Get-ChildItem:*)` | PowerShell commands starting with `Get-ChildItem` |
| `Edit(*.ts)`                  | Edit operations on `.ts` files         |
| `Write(src/**)`               | Write operations anywhere under `src/` |

**Quick rule creation:**

When a permission prompt appears, you can click "Always allow {pattern}" or "Always deny {pattern}" to create a persistent rule. A destination picker lets you choose which settings file to save the rule to (local, project, or global).

### Hooks

Run your own command at key moments in a session by dropping a `hooks.json` next to your scripts. The contract is Damocles' own: the child receives one JSON object on stdin (snake_case keys, a uniform tool schema) and replies with one JSON object on stdout. The exit code is health, not a signal — a non-zero exit is fail-soft and **never** blocks; to block, emit JSON (`{"decision":"deny"}` for `tool_call`, `{"decision":"block"}` for `tool_result` / `input`).

| File | Scope | Honored when |
| --- | --- | --- |
| `~/.damocles/hooks.json` | Global | Always |
| `<workspace>/.damocles/hooks.json` | Project | Workspace is trusted |

A hook is live purely by being present (no toggle); the project file requires a trusted workspace. Keys are pi event names (`tool_call`, `input`, `agent_end`, …) plus the Damocles-defined `subagent_end` and `permission_required`. A `tool_call` hook can **block**, **force-allow**, or **rewrite** a tool call; every block/force-allow is logged and surfaced in chat.

```jsonc
{
  "hooks": {
    "tool_call": [
      // Block destructive shell commands: emit a deny JSON when the command matches.
      { "match": "Bash",
        "command": "in=$(cat); echo \"$in\" | jq -e -r '.input.command | test(\"rm -rf\")' >/dev/null && echo '{\"decision\":\"deny\",\"reason\":\"Refusing rm -rf\"}'" }
    ],
    "permission_required": [
      { "command": ["uv", "run", "${workspaceFolder}/.damocles/hooks/notify.py", "--notify"] }
    ]
  }
}
```

Full guide — event table, variable substitution, the stdin/output contract, and worked examples: [`docs/hooks.md`](docs/hooks.md).

### Persistent Memory

Damocles gives the agent persistent memory that survives across compactions and sessions. Memories are stored locally in WASM-based SQLite (`~/.damocles/memory.v2.db`) — no native modules, works on every platform without compilation.

**Kinds and scopes:**

Every memory carries a **kind** and a **scope**:

| Kind          | What it is                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| `fact`        | A durable truth about the project or user                                      |
| `preference`  | A stated user / style preference                                               |
| `episode`     | Time-bound context ("currently working on X") that decays after ~30 days       |
| `observation` | A structured record of completed work (agent-authored)                         |
| `note`        | A free-form knowledge-base entry (browse / search on demand, not auto-injected)|

| Scope     | Visible in                                  |
| --------- | ------------------------------------------- |
| `session` | The current conversation only               |
| `project` | The current workspace, across its sessions  |
| `global`  | Every workspace                             |

Facts, preferences, and episodes are created **automatically** by extraction; you can also create them explicitly with `/remember` (`project:` / `global:` prefixes set scope) or have the agent call `save_memory`. Notes are created with `/note` and retrieved on demand. Observations are recorded by the agent via `save_observation`; the most recent surface in context. Episodes decay on a ~30-day TTL unless reused (then promoted to durable). Pinned memories of any kind are always injected in full.

**How the catalog works:**

Every prompt you send receives a relevance-ranked catalog of available memories. The catalog builder:

1. Runs FTS5 full-text search against your prompt to find relevant memories
2. Scores each memory using a composite signal:
   - **Prompt relevance** (50%): BM25 text similarity (FTS5 with porter stemming)
   - **Recency** (15%): How recently was the memory created/updated?
   - **Scope priority** (15%): Session > Project > Global
   - **File proximity** (10%): Does the memory mention the file you have open?
   - **Retrieval boost** (10%): How often has the agent actively retrieved this memory?
3. Takes the top N entries per scope/kind (entry-count limits, not token budgets); notes are excluded (browse-on-demand)
4. Formats as a compact catalog: short text for session/project/global (truncated entries include ID for retrieval), title + ID for observations
5. Injects pinned memories as full content, plus the auto-maintained user profile on the first message

`search_memories` reranks its BM25 hits with a cheap LLM (ungraded hits keep their BM25 standing); the per-turn injected catalog can optionally be reranked too under a hard ~2 s cap (`damocles.memory.rerank.injectMode`).

When the prompt doesn't match any memories, scoring falls back to a recency-dominant heuristic. The agent browses the catalog and calls `get_memory_details` to retrieve full content for observations that look relevant to the current task.

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

The agent sees the catalog (~300-800 tokens) and decides what to retrieve. For complex problems, it naturally retrieves less. For context-heavy tasks, it pulls exactly what it needs.

**Smart session handoff:**

When you start a new session in the same workspace, the first message automatically includes:

- Top-ranked observations from recent sessions, scored by prompt relevance, file proximity, and recency

**MCP tools for the agent:**

The agent has 10 memory tools it can use autonomously:

- `save_memory` — Save a typed memory with an explicit kind and scope (`fact` / `preference` / `episode`)
- `save_observation` — Record structured observations after significant work
- `search_memories` — Full-text search (semantically reranked) returning a compact index (~30 tokens/result)
- `get_memory_details` — Fetch full content for specific memory IDs (also records retrievals for feedback)
- `get_memory_history` — Inspect the version chain of a fact (root → latest)
- `get_related_memories` — Traverse the fact graph over updates/extends/derives/supersedes edges
- `forget_memory` — Forget a memory by id or content (default forgets the whole version chain)
- `save_note` / `list_notes` — Knowledge base management
- `reset_observation_staleness` — Mark an observation as fresh after verifying its content

**Memory panel:**

Type `/memories` to open the management panel where you can browse, create, delete, pin, forget, and search memories — with kind/scope filter chips, a forgotten toggle, version-history and related-memories views, and an inline editor for the user profile.

### Per-Panel Models

Each open panel can have its own model independent of other panels. The settings panel shows two model selectors:

- **This panel**: The model for the current panel's session (applies immediately)
- **Default for new panels**: The global default that new panels inherit when opened

Changing the default does not affect any existing panel's session — only new panels pick up the new default.

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `damocles.permissionMode` | How to handle tool permissions (`default`, `acceptEdits`, `plan`) | `default` |
| `damocles.dangerouslySkipPermissions` | Open new chat panels with YOLO mode (skip all permission prompts) enabled by default; each panel can still toggle it off | `false` |
| `damocles.ideContext.enabled` | Attach the active editor's opened file / selection as context; when off, new panels start with the IDE context chip disabled | `true` |
| `damocles.maxTurns` | Maximum conversation turns per session | `100` |
| `damocles.thinkingDisabled` | Workspace default for the thinking-disabled toggle (per-panel override available in settings panel) | `false` |
| `damocles.effortByModel` | Workspace default reasoning effort per model (e.g., `{"claude-opus-4-8": "max", "claude-sonnet-4-6": "high"}`); per-(panel, model) overrides available in settings panel | `{}` |
| `damocles.maxThinkingTokens` | Workspace default max thinking-token budget for legacy (non-adaptive) models (1000–63999); per-(panel, model) overrides available in settings panel | `null` |
| `damocles.maxIndexedFiles` | Maximum files to index for @ mention autocomplete | `5000` |
| `damocles.agentProgressSummaries` | Enable real-time progress summaries on running subagent cards | `true` |
| `damocles.subagents.maxConcurrent` | Maximum background subagents that run concurrently (1–16); excess spawns queue and drain as slots free | `4` |
| `damocles.mcp.enabled` | Enable MCP servers from `.mcp.json` and imported Claude Code / Desktop config; disable to hide all MCP tools without editing config | `true` |
| `damocles.pi.webSearch.enabled` | Enable native key-free web tools (WebSearch, WebFetch, CodeSearch) via Exa; toggling takes effect next turn, no install or reload | `false` |
| `damocles.assetSourcePrecedence` | Which source wins when a skill or slash command exists in both `.claude` and `.codex` with the same name (`claude`, `codex`); affects the agent's loaded resources and the slash-command menu | `claude` |
| `damocles.explore.enabled` | Route the `Explore` subagent through a third-party provider (native multi-provider; keys in SecretStorage) | `false` |
| `damocles.explore.provider` | Explore provider when routing is enabled (`openrouter`, `gemini`, `stepfun`) | `openrouter` |
| `damocles.explore.modelByProvider` | Per-provider model override (keys: `openrouter`, `gemini`, `stepfun`) | `{}` |
| `damocles.voice.mode` | Voice input mode (`off`, `push-to-talk`, `wake-word`) | `off` |
| `damocles.voice.provider` | Push-to-talk speech-to-text provider (`openai-whisper`, `deepgram`, `google-cloud-stt`) | `openai-whisper` |
| `damocles.voice.language` | Language code for voice transcription (e.g., `en`, `el`, `de`) | `en` |
| `damocles.voice.wakeWord` | Jarvis: bundled wake-word ID (e.g., `hey_jarvis`) or absolute path to a custom `.onnx` (machine-scope) | `hey_jarvis` |
| `damocles.voice.wakeWordSensitivity` | Jarvis: detection threshold (0.1–0.95). Lower = more sensitive | `0.5` |
| `damocles.voice.tts.enabled` | Jarvis: speak the assistant's reply aloud (adds ~1.5 GB GPU) | `false` |
| `damocles.voice.tts.voice` | Jarvis: VibeVoice voice prefill | `en-Carter_man` |
| `damocles.voice.localGpu` | Jarvis: compute device (`auto`, `cuda`, `cpu`) | `auto` |
| `damocles.voice.endOfTurnSilenceMs` | Jarvis: silence (ms) that ends an utterance and triggers transcription | `800` |
| `damocles.voice.maxUtteranceMs` | Jarvis: hard cap (ms) on a single utterance | `30000` |
| `damocles.voice.autoSubmit` | Jarvis: auto-send the message when the local transcript finalizes | `true` |
| `damocles.voice.diagnostics` | Jarvis: verbose sidecar logs in the "Damocles Voice" output channel (no transcript content) | `false` |
| `damocles.voice.runtimePath` | Jarvis: path to an existing CUDA-PyTorch venv to skip the bundled runtime (machine-scope) | `""` |
| `damocles.voice.pinModelVersion` | Jarvis: per-model version pin overriding `MODEL_MANIFEST.json` (machine-scope) | `{}` |
| `damocles.autoCompact.enabled` | Enable automatic context compaction (opt-in; applies to all providers including GPT) | `false` |
| `damocles.autoCompact.triggerPercent` | Compact once context usage crosses this % of the window (50–95) | `80` |
| `damocles.memory.enabled` | Enable persistent memory system | `true` |
| `damocles.memory.pinnedTokenBudget` | Token budget for pinned memories | `500` |
| `damocles.memory.catalogObservationLimit` | Max observation entries in catalog | `20` |
| `damocles.memory.catalogProjectLimit` | Max project memory entries in catalog | `15` |
| `damocles.memory.catalogGlobalLimit` | Max global memory entries in catalog | `10` |
| `damocles.memory.autoExtract.enabled` | Auto-extract durable memories from conversations during consolidation | `true` |
| `damocles.memory.autoExtract.idleSeconds` | Seconds of inactivity before an idle consolidation pass runs | `180` |
| `damocles.memory.rerank.enabled` | Rerank `search_memories` BM25 candidates with an LLM | `true` |
| `damocles.memory.rerank.candidatePool` | BM25 candidates to over-fetch before reranking | `30` |
| `damocles.memory.rerank.injectMode` | Per-turn catalog ranking — `off` (pure BM25) or `blocking` (rerank, ~2 s cap) | `off` |
| `damocles.memory.profile.enabled` | Maintain and inject an auto-generated user profile | `true` |
| `damocles.memory.profile.tokenBudget` | Max tokens of profile injected on the first message of a session | `400` |
| `damocles.memory.dedup.threshold` | Similarity above which a new memory is merged as a near-duplicate at consolidation | `0.8` |
| `damocles.pinnedHeaderHidden` | Hide the pinned user-message sticky header; a floating chip restores it (global scope, persists across workspaces) | `false` |

## Localization

The extension automatically uses VS Code's display language. Currently supported:

| Language | Code |
| -------- | ---- |
| English  | `en` |
| Greek    | `el` |

To change the language, set VS Code's display language via **Configure Display Language** command (`Ctrl+Shift+P` → "Configure Display Language").

## Requirements

- VS Code 1.95.0 or higher
- For Claude models: a Claude subscription (Pro, Max, Team, Enterprise) **or** an `ANTHROPIC_API_KEY` — see Authentication below
- For GPT models: a ChatGPT/Codex subscription **or** an `OPENAI_API_KEY`
- For StepFun / DeepSeek models: the respective provider API key (set in their Settings panels)
- **Supported platforms**: Windows, macOS, and Linux. Memory and Compass use WASM SQLite (no native modules), so there is nothing to compile per platform. Voice's wake-word mode runs a separate Python sidecar (see the voice guide)

## Authentication

Damocles runs on the [pi](https://github.com/earendil-works/pi) agent engine and talks to Anthropic and OpenAI directly. It owns its own credentials, sessions, and plans under `~/.damocles/`, fully isolated from the standalone Claude Code CLI — signing in or out of either tool never affects the other. Damocles reads the CLI's `~/.claude/` settings, skills, agents, and slash commands directly so those stay shared, while the CLI's credentials are never read, written, or deleted.

Sign in from the settings panel (gear icon in the chat header). The extension refreshes the active session automatically once you authenticate, and the chat header shows your account info (email, subscription type). If startup fails because credentials are missing or expired, the chat panel surfaces a dismissable banner with a **Sign In** shortcut.

### Claude (Anthropic)

The **Claude Authentication** panel offers three modes:

- **API key** — your `ANTHROPIC_API_KEY`; bills your Anthropic API account.
- **Subscription · extra usage** — signs in to your Claude Pro/Max subscription via OAuth; usage is **metered** (pay-as-you-go) against the subscription.
- **Subscription · allowance** — the *same* OAuth token, routed through the third-party [`pi-anthropic-oauth`](https://github.com/AizenvoltPrime/pi-anthropic-oauth) plugin so requests impersonate Anthropic's official Claude Code CLI and draw on your subscription's **included quota** (no metered charge). Switching allowance ↔ extra usage just toggles that plugin — no re-login.

> ⚠️ **The "allowance" mode very likely violates Anthropic's Terms of Service.** It makes a third-party tool masquerade as Anthropic's official CLI to draw on your subscription's *included* (free) quota it is not entitled to, and may result in account action. Use it entirely at your own risk. "API key" (API account) and "extra usage" (metered against your subscription — you pay for what you use) do not access included quota this way and are not affected.

### OpenAI / GPT

GPT models authenticate two ways:

- **ChatGPT / Codex OAuth** — sign in with your ChatGPT subscription.
- **API key** — your `OPENAI_API_KEY`.

Codex wins when both are configured; `damocles.openai.preferApiKey` inverts the preference.

### StepFun / DeepSeek

Dedicated API-key panels (below OpenAI Authentication) enable these custom-provider models. Keys are saved to SecretStorage without a validation probe — an invalid key surfaces as a normal request error on first use.

- **StepFun** — Bearer token for the step-plan flat-fee subscription (enables Step 3.7 Flash). Shares one key with the Explore StepFun provider, so saving/clearing in either place keeps both in sync.
- **DeepSeek** — `DEEPSEEK_API_KEY` (pay-per-token; enables DeepSeek V4 Pro and V4 Flash). Dollar-budget-enforced like other metered providers.

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

# Run tests
npm test
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

- **Extension Host** (Node.js): runs the pi agent engine, tools, permissions, and all subsystems
- **Webview** (Vue 3 + Tailwind): chat interface
- **postMessage Bridge**: communication between extension and webview
