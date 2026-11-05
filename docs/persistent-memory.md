# Persistent memory

This page covers Damocles' persistent memory: what it stores, how memories are extracted, judged and injected into prompts, and the tools and panels that manage them.

Damocles also loads `AGENTS.md` and `CLAUDE.md` instructions files, as described in [Instructions files](usage.md#instructions-files).

## Storage

Damocles gives the agent persistent memory that survives across compactions and sessions, giving the agent continuity across conversations. Memories are stored locally in SQLite via Node's built-in `node:sqlite` (WAL mode, `~/.damocles/memory.v3.db`; your v2 data is imported once on first run), with no native modules or WASM, so it works on every platform without compilation.

Memory is enabled by `damocles.memory.enabled`. Memory settings are listed in [Configuration](configuration.md#settings).

## Kinds and scopes

Every memory carries a **kind** and a **scope**:

| Kind          | What it is                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| `fact`        | A durable truth about the project or user                                       |
| `preference`  | A stated user / style preference                                                |
| `episode`     | Time-bound context ("currently working on X") that decays after about 30 days   |
| `observation` | A structured record of completed work (agent-authored)                          |
| `note`        | A free-form knowledge-base entry (browse / search on demand, not auto-injected) |

| Scope     | Visible in                                 |
| --------- | ------------------------------------------ |
| `session` | The current conversation only              |
| `project` | The current workspace, across its sessions |
| `global`  | Every workspace                            |

When the VS Code extension runs on a remote (Remote-SSH, WSL, Dev Containers, Codespaces), its global memories are the server's, and the panels label them "Global (this server)".

Facts, preferences, and episodes are created **automatically** by extraction; you can also create them explicitly with `/remember` (`project:` / `global:` prefixes set scope) or have the agent call `save_memory`. Notes are created with `/note` and retrieved on demand. Observations are recorded by the agent via `save_observation` and surface when a prompt is relevant to them. Episodes decay on a 30-day TTL unless reused (then promoted to durable). Pinned memories of any kind are injected in full once per context.

## Memory commands

- `/remember <text>` saves session memory (prefix `project:` or `global:` for broader scope).
- `/note <text>` saves to a searchable knowledge base.
- `/memories` opens the management panel.

## Observations

The agent voluntarily records rich observations via an MCP tool after significant work, as structured entries with type, title, narrative, facts, tags, and file paths. This costs no additional API calls.

**Observation staleness.** When source files referenced by an observation are modified, the observation is automatically marked stale. The agent sees `[stale]` tags in context and can verify whether the observation is still accurate, then mark it fresh via the `reset_observation_staleness` MCP tool.

## Fact graph and versioning

Facts evolve through `UPDATES` / `EXTENDS` / `DERIVES` / `SUPERSEDES` edges. When a fact is updated the old version is retained (not deleted) and browsable via `get_memory_history`; `get_related_memories` traverses the graph. `forget_memory` drops a memory by id or content, by default forgetting the entire version chain so an older version cannot resurface.

## Automatic extraction

After a conversation goes idle (or on session switch), a background pass extracts durable facts, preferences, and episodes from the turns, deduping exact and near-duplicate content, resolving contradictions, and decaying time-bound episodes (about 30-day TTL, promoted when reused), so memory accrues without manual `/remember`. It runs on the Background model, a cheap one unless you pick another in Settings, and is crash-safe (a batch is never lost mid-extraction). It is gated by `damocles.memory.autoExtract.enabled`.

### What gets extracted

When a conversation goes idle, the Background model (Settings › Models & accounts › Background work, `damocles.background.model`) reads the queued turns and keeps only what would change how a future agent works in that scope: gotchas with their cause, environment quirks, conventions, decisions with their rationale, commands verified to work, and your preferences. It skips progress and status ("slice done", "awaiting logs"), release notes and test counts, anything readable from the repository or git history, speculation, and personal details unrelated to the work. Most turns produce nothing. The profile follows the same rules: its static section holds identity and environment, its dynamic section the current focus, and it never repeats a preference, because preferences are injected verbatim.

### Which workspace a memory lands in

Each queued turn records the files its tool calls touched. When a project memory is about another repository, extraction files it under that repository, so GPU work on `psychic_smash` done from a `damocles` window becomes `psychic_smash` memory. Extraction can name only a folder open in the window, or a repository you have memories for that holds a file the turns touched. An observation whose files all sit in one other known workspace is filed there too, and the `save_observation` result names that workspace. An observation whose files all sit inside the window's workspace stays there, even when a nested folder has memories of its own, and mixed or relative paths also stay in the current workspace. Your home folder, where a window with no folder open keeps its memories, is never offered as another repository.

## User profile

A short auto-maintained summary of you: a static section plus a recent-activity dynamic section, per project and global scope, regenerated during consolidation and injected once per context, and again after compaction. Edit it inline in the Memory Panel; set its budget via `damocles.memory.profile.tokenBudget`.

## Pinned memories

User-designated memories injected in full once per context, bypassing the relevance gate. Pin and unpin via the overlay UI. The budget is configurable (default 500 tokens).

## Retrieval tracking

When the agent fetches, inspects or updates a memory by id (or you paste its id into a prompt), the retrieval is recorded and fed back into injection ranking. Memories the agent actively uses rank higher later, a closed feedback loop.

## How injection works

Damocles uses **delta injection behind a relevance gate**. Before each prompt, Damocles adds the memories that are new and relevant to it. Each memory reaches the model once per context: later prompts add only what the conversation does not already carry, so a follow-up prompt usually adds nothing or a few hundred tokens. What the model already has is read from the conversation itself, so rewinding, forking and compacting are all handled: after `/compact`, relevant memories and the profile come back.

1. **Always once per context**, without needing to match: the user profile, pinned memories (500-token budget), this conversation's session memories (500 tokens, newest first) and your preferences (600 tokens, project before global, then the ones re-learned or retrieved most), which are working rules. Preferences that do not fit compete through the relevance gate like any other memory.
2. **Mentioned ids**: a memory id pasted into the prompt is shown in full, from any workspace, up to 10 per prompt and outside the token budget. An old version or a merged duplicate shows the current memory, and a forgotten memory is shown marked `forgotten="true"`.
3. **Relevance gate** for everything else. Only the words you typed are searched: the opened-file or selection context Damocles attaches is not. That context's file is the only one treated as open in your editor, so a prompt sent without it has no editor file. Words are matched against a memory's own text, never the synonyms generated for search. A path you type is used to find memories about that file, not as words: a file path adds no search words, a folder path adds only its last folder, and a file name such as `OrganizationScope.php` adds `OrganizationScope` without the extension. Each word is judged against your store and against bundled lists of about 49,000 frequent English words and 3,700 software words (`repo`, `json`, `regex`), and a word counts as the listed word it shares a stem with, so `summarization` is as ordinary as `summarize`: words common in your store and the 1,000 most frequent English words are dropped, UUIDs and commit hashes are never search terms. A word in neither list (a name, an identifier, a file stem) is distinctive. When the prompt has a distinctive word, a memory passes only by matching one. Otherwise it must match all of the prompt's remaining words, or three of them when there are more, and is shown only as a one-line summary. Ordinary words add relevance but never admit a memory alone. Words in other scripts, such as Greek, identifiers of 3 or more characters that start with a letter and hold a digit, such as `oauth2` or `es2022`, and every unlisted word of a prompt written mostly in another language are distinctive only when they are rare in your store. Numbers, timestamp pieces and two-character mixes such as `s3` add relevance but never admit a memory. A memory about the file open in your editor (or a path you typed) can pass on that alone.
4. **Ranking and tiers.** Gated memories are scored by relevance (55%), file proximity (15%), recency (15%) and how often the agent retrieved them (10%), plus a small boost that grows with how often the memory was re-learned; stale observations rank lower. The top ones are shown in full when they matched a distinctive word and the words they matched carry at least 40% of the prompt's search weight, and the next ones as one-line summaries with their id, which the agent can expand with `get_memory_details`. A memory that passed on its file alone is shown as a summary. `damocles.memory.injection.fullEntryLimit` and `damocles.memory.injection.compactEntryLimit` are maximums, and `catalogTokenBudget` caps the memories that pass the relevance gate: over budget, the lowest full entries become summaries first, then the lowest summaries are dropped.
5. **Updates.** When a memory the model already saw is edited, superseded, merged into another or forgotten, the next prompt says so once. An edit or a replacement carries the new text, unless the replacement is already in context. A forget carries no text and says whether you forgot the memory or it was retired, for example an episode that decayed. At most 10 notices, or 600 tokens of them, go out per prompt, and the rest follow with later prompts.

When nothing new is relevant, no memory block is sent at all. Notes are never injected; browse them on demand.

### Example injected block

```xml
<damocles_memory>
<memory id="mem-arch-uuid" kind="preference" scope="project" pinned="true">Always use the repository pattern for data access.</memory>
<observation id="obs-auth-uuid" type="fix" scope="project" files="src/auth-service.ts">
<title>Token refresh race fixed</title>
Two refreshes could run at once; the second now waits on the first.
<facts>
- JWT tokens expire after 1 hour
</facts>
</observation>
<compact>
- [mem-db-uuid] (project fact) Database uses Knex with PostgreSQL. Migrations in db/migrations/
</compact>
<memory_updates>
- [mem-old-uuid] was forgotten by the user. Disregard it.
</memory_updates>
</damocles_memory>
```

### Injected-context viewer

Each prompt has a "View injected context" pill that opens an overlay showing what was added for that prompt, why, what was already in context from earlier prompts, and the exact text the model received. Each memory shows why it was included, with the matched words highlighted, and a ranked memory shows its score; a "Reranked" badge marks a prompt whose matches a model reranked. The overlay also shows the query terms, the profile and the Compass status, and you can pin, forget or open a memory in the memory panel from its card.

## Reranking and the memory judge

`search_memories` reranks its BM25 hits with a cheap LLM (ungraded hits keep their BM25 standing); the injected memories can optionally be reranked too under a hard 2 s cap (`damocles.memory.rerank.injectMode`), where a `low` grade demotes a memory to a one-line summary.

Reranks and the contradiction judge that decides whether a new fact supersedes an old one follow **Memory judge** (Settings › Models & accounts › Background work, `damocles.memory.judge`).

On Automatic they run on the first available classifier:

1. TypeSafe's **Jev** when a TypeSafe key (Settings, below the OpenRouter panel) is configured
2. else Jev through OpenRouter when an OpenRouter key or sign-in (Settings › Models & accounts › OpenRouter) is
3. else OpenAI's **GPT-6 Luna** on its Decisions API when an OpenAI API key is the active OpenAI credential. The Decisions API does not accept a Sign in with ChatGPT token, so with ChatGPT signed in Luna judges only while **Prefer API key over ChatGPT sign-in** is on.

With no classifier, Automatic uses the first signed-in of Haiku 5.5, GPT-6 Luna, Step 5 Preview, DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Grok 4.7, Kimi for Coding and Muse Spark 1.3, never a GitHub Copilot model.

You can instead choose one classifier or any model from the model picker, with its reasoning effort. A choice that cannot run (its key is missing or refused, its provider signed out, or this version no longer offers it) is never swapped for another: the Memory judge row and the TypeSafe panel say "none" and why, the dropdown lists a classifier whose key is missing and a model whose provider is signed out as unavailable with the reason, and merges and reranks wait until it can run. The Background model never judges.

The TypeSafe panel names the judge in use; until a chat has started, it can name only a classifier, because the judge model is resolved when pi starts. If a classifier provider refuses the key (for example an OpenRouter account with no credit), Damocles stops sending classifier requests there, the panel says why, and it tries again after 5 minutes or as soon as you save that key, even unchanged; for OpenAI, any change of the key, the prefer toggle or the ChatGPT sign-in counts. On Automatic, a contradiction the classifier is unsure about goes to the small model, and a rerank the classifier cannot answer in time falls back to the small model, then to lexical order.

A reranked memory's tooltip in the Injected Context view, and a search result in the Memory panel, show the classifier's verdict and score. Each classifier call is recorded in `/stats` like other sub-calls. pi's catalog prices TypeSafe's `jev-latest` at 0, so `/stats` counts TypeSafe Jev calls as unpriced tokens with no dollar cost, although TypeSafe may bill them; OpenRouter's Jev and GPT-6 Luna are priced.

## Memory tools

The agent has 12 native in-process memory tools it can use autonomously. Progressive disclosure keeps token usage low.

- `save_memory`: Save a typed memory with an explicit kind and scope (`fact` / `preference` / `episode`)
- `save_observation`: Record structured observations after significant work
- `search_memories`: Full-text search (semantically reranked) returning a compact index (about 30 tokens per result)
- `get_memory_details`: Fetch full content for specific memory IDs. It, `get_memory_history`, `get_related_memories`, `update_memory` and `reset_observation_staleness` record a retrieval, which raises the memory's ranking
- `get_memory_history`: Inspect the version chain of a fact (root → latest)
- `get_related_memories`: Traverse the fact graph over updates/extends/derives/supersedes edges
- `update_memory`: Update a memory's content (a fact or preference gets a new version)
- `forget_memory`: Forget a memory by id or content (default forgets the whole version chain)
- `unforget_memory`: Restore a forgotten memory by id
- `save_note` / `list_notes`: Knowledge base management
- `reset_observation_staleness`: Mark an observation as fresh after verifying its content

## Memory panel

Type `/memories` to open the full-screen management overlay for browsing, creating, deleting, pinning and unpinning, forgetting, and searching memories, with kind/scope filter chips, a forgotten toggle, version-history and related-memories dialogs, and an inline editor for the auto-maintained user profile. Each row marks a pinned memory, a stale one (its files changed 3 or more times since it was recorded, the same rule the injection gate uses), how many times the agent used it, and its version.

## Quality audit

The memory panel header has a "Quality audit" button that grades the existing store by the same usefulness rules extraction uses. The panel also shows a banner, which you can dismiss, while you have 20 or more eligible memories and have never run an audit. The audit first shows an estimate of tokens and cost for the Background model: the cost reads "unpriced" when the model has no price, and when no model has a credential the audit cannot run. It then grades every live, unpinned fact, preference, episode and observation, plus each profile, and records proposals: forget, move to global (never an observation), move to another workspace, turn a fact into an episode, or rewrite a profile.

You set each proposal to Accept, Undecided or Reject. Apply acts only on the proposals you accepted or rejected, and undecided ones stay pending. A proposal whose memory changed or was pinned after grading is skipped as stale, and Apply reports how many changes it applied, rejected and skipped. One run executes at a time across all windows, and a run in which every grading call failed is reported as failed.

The latest run's applied changes can be reverted until a new audit starts. Revert leaves a memory as it is when it was edited, pinned or superseded since, or when it was moved out of a conversation that has since been deleted. While the latest run has undecided proposals or applied changes, starting a new audit asks for confirmation first, because those proposals turn stale and those changes can no longer be reverted. Memories the audit forgets keep the reason `quality_audit` and are never purged, so a revert or an unforget can still find them.

## Consolidation panel

A header pill beside the prompt navigator opens a live view of the consolidation pipeline:

- a five-phase stepper (Claim → Extract → Persist → Maintain → Profiles) with honest progress: a turns counter for Extract, which sweeps until its first call returns, and a determinate `x/y` counter for Persist
- the conversation turns queued for the next pass
- the last run's extracted memories with outcome badges, an Auto/Manual trigger chip, and a relative timestamp

From a run's second pass, or once a pass has kept memories, it shows that run's memories so far and the status strip names the pass.

A failed pass shows a distinct failure card with **Retry now** (and **Sign in to a model** when no extraction model is signed in or its sign-in was refused, but not when the provider refuses access with HTTP 403), separate from the neutral "nothing new to remember" state. Failures also surface as an error dot on the toolbar icon while the overlay is closed. A turn the model declines when sent alone, in three separate runs, is set aside; the card counts set-aside turns, after a reload too, and **Return to queue** sends them back. A **Run now** button triggers consolidation manually. Memory extraction runs on your Settings › Models & accounts › Background work model (`damocles.background.model`).
