# Configuration

This page lists the `damocles.*` settings and the UI languages.

Most `damocles.*` settings apply to the whole window; the ones a chat reads for itself can also be set per folder, as described in [Per-panel workspace folders](usage.md#per-panel-workspace-folders). Permission rules live in settings files described in [Permissions](permissions.md), hooks in `hooks.json` files described in [Hooks](hooks.md), and MCP servers in the files described in [MCP servers](mcp.md).

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| `damocles.permissionMode` | How to handle tool permissions (`default`, `acceptEdits`, `plan`) | `default` |
| `damocles.dangerouslySkipPermissions` | Open new chat panels with YOLO mode (skip all permission prompts) enabled by default; each panel can still toggle it off | `false` |
| `damocles.ideContext.enabled` | Attach the active editor's opened file / selection as context; when off, new panels start with the IDE context chip disabled | `true` |
| `damocles.thinkingDisabled` | Workspace default for the thinking-disabled toggle (per-panel override in Settings › This chat); ignored on models that always think or use effort alone (OpenAI models, Fable 5.1, Opus 5.5, Sonnet 5.5, Step 5 Preview, MiniMax M3.1 Flash, Grok 4.7, K3, Kimi for Coding, Muse Spark 1.3, Muse Wonder 1.0), where Settings shows the switch disabled | `false` |
| `damocles.effortByModel` | Workspace default reasoning effort per model (for example `{"claude-opus-5-5": "max", "claude-sonnet-5-5": "high"}`); per-(panel, model) overrides in Settings › This chat; a model with no entry uses its catalog default where it has one (High on Opus 5.5 and Sonnet 5.5) | `{}` |
| `damocles.maxIndexedFiles` | Maximum files to index for @ mention autocomplete | `5000` |
| `damocles.checkpoints.retentionDays` | Delete a conversation's file checkpoint (undo/rewind) history after this many days of inactivity to reclaim disk; repos are always compacted regardless. `0` keeps history forever. User settings only | `30` |
| `damocles.checkpoints.maxFileSizeMB` | Leave files larger than this out of checkpoints (1-2048); the rewind view lists them and a rewind leaves them as they are | `25` |
| `damocles.checkpoints.baselineWaitSeconds` | How long a file-changing tool waits for the turn's first checkpoint (5-600); past it the tool runs and the turn is marked not rewindable | `30` |
| `damocles.subagents.maxConcurrent` | Maximum subagents a chat runs at once, foreground and background together (1-16); further spawns wait until one finishes. Team members are not counted | `4` |
| `damocles.mcp.enabled` | Enable MCP servers from all eight sources (`.damocles/mcp.local.json`, `.mcp.json`, `~/.damocles/mcp.json`, Claude Code's local scope, `.pi/mcp.json`, `~/.pi/agent/mcp.json`, Claude Code / Desktop, `~/.codex/config.toml`); disable to hide all MCP tools without editing config | `true` |
| `damocles.mcp.toolExposure` | Per-tool MCP state, `{ "<server>": { "<tool>": "off" \| "deferred" \| "direct" } }`, set from the MCP panel; local over project over user, project and local only in a trusted folder | `{}` |
| `damocles.mcp.resourceExposure` | Per-server MCP resources state, `{ "<server>": "off" \| "deferred" \| "direct" }`, set from the MCP panel's Resources row; with no entry, Off for `exposeResources: false` or `exposure: "hidden"`, Always loaded for `exposure: "direct"`, otherwise On; local over project over user, project and local only in a trusted folder | `{}` |
| `damocles.pi.webSearch.enabled` | Enable native key-free web tools (WebSearch, WebFetch, CodeSearch, FeedRead, YouTubeTranscript); toggling takes effect next turn, no install or reload | `false` |
| `damocles.team.enabled` | Enable the collaborative multi-agent team system | `false` |
| `damocles.team.leadModel` / `damocles.team.implementorModel` / `damocles.team.reviewerModel` | Model for each team role; empty uses the active panel model | `""` |
| `damocles.team.leadEffort` / `damocles.team.implementorEffort` / `damocles.team.reviewerEffort` | Reasoning effort for each team role; empty or a level the model does not support uses the model default | `""` |
| `damocles.assetSourcePrecedence` | Breaks a tie between `.claude` and `.codex` when a skill, slash command or MCP server with the same name exists in both (`claude`, `codex`). `.damocles` always outranks both and is not affected by this setting. Applies to every project, open chats included. User settings only | `claude` |
| `damocles.modelPicker.providers` | Which providers the chat's model picker lists, `{ "<provider>": true \| false }`, set by **Show in model picker** in Settings › Models & accounts. A provider left unset is listed while it has a credential, and the chat's current model always is. User settings only | `{}` |
| `damocles.explore.model` | Model for the `Explore` subagent. `""` is Default, the small model of the chat's provider (Haiku 5.5, GPT-6 Luna, a key provider's own small model, or GitHub Copilot's Haiku 5.5 for a Copilot chat) at medium effort, or the chat's own model at the chat's effort when that small model is signed out, outside your plan or outside pi's `enabledModels`; any model from the model picker otherwise. A picked model whose provider is signed out, that is outside your plan, or that is outside pi's `enabledModels`, fails the spawn naming this setting and never falls back. User settings only | `""` |
| `damocles.explore.effort` | Reasoning effort for a picked Explore model; `""` runs at medium, which pi raises to the next level the model supports, else lowers to its highest. Ignored on Default. User settings only | `""` |
| `damocles.background.model` / `damocles.background.effort` | Model for background work: chat titles, memory extraction, profiles, query expansion, the quality audit and the desktop app's commit messages. `""` is Automatic, the first signed-in of Haiku 5.5, GPT-6 Luna, Step 5 Preview, DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Grok 4.7, Kimi for Coding and Muse Spark 1.3, never a GitHub Copilot model; a picked model whose provider is signed out, or that is outside your plan, pauses that work and never falls back. The effort applies only to a picked model; `""` (Per job) runs each job at its own level. User settings only | `""` |
| `damocles.memory.judge` / `damocles.memory.judgeEffort` | What runs the memory merge and rerank judges. `""` is Automatic: the first available classifier of Jev on TypeSafe (`jev-typesafe`), Jev on OpenRouter (`jev-openrouter`) and GPT-6 Luna on the Decisions API (`gpt-6-luna-classifier`, API key only), skipping one whose key was refused, then the first signed-in of Haiku 5.5, GPT-6 Luna, Step 5 Preview, DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Grok 4.7, Kimi for Coding and Muse Spark 1.3. A chosen classifier or model that cannot run leaves merges and reranks waiting and never falls back. The effort applies only to a chosen model; `""` (Per job) runs the judges as low as the model allows. User settings only | `""` |
| `damocles.voice.mode` | Voice input mode (`off`, `push-to-talk`, `wake-word`) | `off` |
| `damocles.voice.provider` | Push-to-talk speech-to-text provider (`openai-whisper`, `deepgram`, `google-cloud-stt`) | `openai-whisper` |
| `damocles.voice.language` | Language code for voice transcription (for example `en`, `el`, `de`) | `en` |
| `damocles.voice.wakeWord` | Jarvis: wake phrase of 1 to 4 English words of letters only; underscores read as spaces (machine-scope) | `hey jarvis` |
| `damocles.voice.wakeWordSensitivity` | Jarvis: detection threshold (0.1-0.95). Lower = more sensitive | `0.5` |
| `damocles.voice.tts.enabled` | Jarvis: speak the assistant's reply aloud (adds about 1.5 GB GPU) | `false` |
| `damocles.voice.tts.voice` | Jarvis: VibeVoice voice prefill | `en-Carter_man` |
| `damocles.voice.localGpu` | Jarvis: compute device (`auto`, `cuda`, `cpu`) | `auto` |
| `damocles.voice.endOfTurnSilenceMs` | Jarvis: silence (ms) that ends an utterance and triggers transcription | `800` |
| `damocles.voice.maxUtteranceMs` | Jarvis: hard cap (ms) on a single utterance | `30000` |
| `damocles.voice.autoSubmit` | Jarvis: auto-send the message when the local transcript finalizes | `true` |
| `damocles.voice.diagnostics` | Jarvis: verbose sidecar logs in the "Damocles Voice" output channel (no transcript content) | `false` |
| `damocles.voice.runtimePath` | Jarvis: Python of an existing venv holding the pinned voice stack, used instead of the bundled runtime; Windows x64, Linux x64 and macOS arm64 only (machine-scope) | `""` |
| `damocles.autoCompact.enabled` | Enable automatic context compaction (opt-in; applies to all providers including GPT) | `false` |
| `damocles.autoCompact.triggerPercent` | Compact once context usage crosses this % of the window (50-95) | `80` |
| `damocles.autoCompact.modelOverrides` | Per-model auto-compact budgets keyed by the model picker's value, for example `{"claude-opus-5-5": {"triggerPercent": 90, "keepRecentPercent": 20}}`. `triggerPercent` is 50-95, `keepRecentPercent` is 1-50 | `{}` |
| `damocles.cacheWarming` | Prompt cache warming: `off`, `streaming` (during a run), `idle` (also up to 30 minutes after). User settings only | `streaming` |
| `damocles.memory.enabled` | Enable persistent memory system | `true` |
| `damocles.memory.pinnedTokenBudget` | Token budget for pinned memories | `500` |
| `damocles.memory.injection.fullEntryLimit` | Max newly relevant memories shown in full per prompt | `4` |
| `damocles.memory.injection.compactEntryLimit` | Max further relevant memories shown as one-line summaries per prompt | `8` |
| `damocles.memory.catalogTokenBudget` | Token budget per prompt for the memories that pass the relevance gate | `2000` |
| `damocles.memory.autoExtract.enabled` | Auto-extract durable memories from conversations during consolidation | `true` |
| `damocles.memory.autoExtract.idleSeconds` | Seconds of inactivity before an idle consolidation pass runs | `180` |
| `damocles.memory.rerank.enabled` | Rerank `search_memories` BM25 candidates with an LLM | `true` |
| `damocles.memory.rerank.candidatePool` | BM25 candidates to over-fetch before reranking | `30` |
| `damocles.memory.rerank.injectMode` | Injection ranking: `off` (lexical only) or `blocking` (rerank the gated memories, 2 s cap) | `off` |
| `damocles.imageGeneration.enabled` | Offer the `GenerateImage` tool, which spends on your OpenRouter key or sign-in. User settings only | `false` |
| `damocles.imageGeneration.model` | OpenRouter image model for `GenerateImage`, picked in Settings | `""` |
| `damocles.memory.profile.enabled` | Maintain and inject an auto-generated user profile; when off, neither consolidation nor the quality audit makes a profile model call | `true` |
| `damocles.memory.profile.tokenBudget` | Max tokens of profile injected, once per context | `600` |
| `damocles.memory.dedup.threshold` | Similarity above which a new memory is merged as a near-duplicate at consolidation | `0.8` |
| `damocles.pinnedHeaderHidden` | Hide the pinned user-message sticky header; a floating chip restores it (global scope, persists across workspaces) | `false` |

Settings mentioned elsewhere in these docs that this table does not list include `damocles.compass.enabled`, `damocles.browser.enabled`, `damocles.browser.devToolsPort`, `damocles.showCacheMissNotices`, `damocles.tools.disabled`, `damocles.mcp.disabledServers`, `damocles.mcp.disabledProjectServers`, `damocles.openai.preferApiKey`, `damocles.<provider>.preferApiKey`, `damocles.maxBudgetUsd` and the desktop app's `damocles.desktop.*` settings; each is described on the page that mentions it.

## Localization

The UI is in English and Greek.

| Language | Code |
| -------- | ---- |
| English  | `en` |
| Greek    | `el` |

The extension automatically uses VS Code's display language until you pick one in Settings › Application › Language, which applies at once. To change VS Code's display language, use the **Configure Display Language** command (`Ctrl+Shift+P` → "Configure Display Language").

The desktop app follows the operating system's language unless `damocles.desktop.language` (the same Settings row) names one, which applies after Restart now and covers the menus and Chromium's own text.

## Requirements

System requirements are listed in the README under [Requirements](../README.md#requirements).
