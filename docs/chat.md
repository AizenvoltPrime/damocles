# Chat interface

This page covers the chat panel: how messages, tool calls and diffs render, how sessions are kept, and the views that report context, cost and usage.

## Panels

The chat panel is available as a secondary sidebar view (right side) or as an editor panel (`Ctrl+Shift+U`). Both modes support all features and can run simultaneously with independent sessions. The agent helps with coding, debugging, refactoring and related work.

- **Panel persistence.** Panels and active sessions survive VS Code restarts.
- **Multi-panel sync.** Prompt history syncs across all open panels instantly.

## User messages

Long user-message bubbles collapse by default (canvas and pinned sticky header alike) with a chevron toggle. Expansion state follows the message across inline and pinned transitions. Drag the handle below an expanded bubble to set the scroll-cap height. The value becomes the global default and persists across webview reloads.

The pinned sticky header can be hidden entirely via the `×` button. When hidden, a small floating pin chip at the top-right of the chat expands on hover to preview the active pinned message, and a click restores the header. Hidden state persists globally via `damocles.pinnedHeaderHidden`. The header also steps aside while it would cover more than half the message list, as when a permission prompt docks in a short window, unless you expanded it, and focused or scrolled-to rows land below it while it shows. Queued or injected messages (sent mid-stream) are skipped by the sticky header and never pin.

## Code and diffs

- **Syntax highlighting.** Shiki-powered code blocks with VS Code-quality highlighting and one-click copy.
- **Diff approval.** Review and approve file changes with syntax-highlighted unified diffs. Concurrent diffs are supported.
- **Inline diff preview.** Edit and Write tool results show inline diff previews with a click-to-expand full-panel view. Lines carry their real numbers in the file: an Edit's come from the patch pi records, a Write that replaces a file records one too, a new file is numbered from 1, and a change awaiting approval is numbered from the file's current and proposed contents. A Write recorded by an earlier version shows its content without numbers, since nothing says whether it created or replaced the file. A change over 10 MiB or 1,000 changed lines, or to a binary file, shows no numbers rather than invented ones.

## Tool calls

- **Tool visualization.** See what tools the agent is using in real time with expandable details. Each completed tool card shows a subtle duration badge (`123ms` / `1.2s` / `1m 23s`).
- **Live shell output.** A running `Bash` or `PowerShell` call streams into a scrolling pane on its card and in the overlay, so a slow build and a hung command stop looking alike. The pane keeps a bounded tail and says when earlier output was dropped. This works in the main session, in subagents and in team agents.

### Stopping one command

A shell call gets a Stop button that ends that command and its children without ending the turn. A Stop pressed before the command starts, while it waits for a checkpoint or for approval, ends the call at once: the command never runs and its card reads denied. The model receives whatever the command printed, so it can react instead of starting over, and the card reads Stopped rather than taking a success check.

Stop can carry a note (Enter sends, Shift+Enter for a new line). The agent reads it in its next step, right after the stopped command's output and before any messages you queued, and answers them in one reply. ESC discards a note the agent has not read yet, and a note sent after the budget limit stopped the turn is not delivered; a warning says so in both cases. The panel interrupt still aborts the whole turn.

A shell killed from outside VS Code, by `kill` or Task Manager rather than by Stop, reports the shell convention exit code of 128 plus the signal number instead of reading as a command that succeeded.

### Tool overlays

Click a tool card to view its full output in a full-screen overlay, including from inside a subagent or team agent overlay. Overlays stack in the order you opened them and Escape closes the top one.

Overlays support built-in tools (Bash, PowerShell, Read, Grep, Glob, WebFetch, WebSearch, CodeSearch, FeedRead, YouTubeTranscript, ToolSearch, CronCreate, CronDelete, CronList) with syntax highlighting or markdown rendering, and MCP tools with markdown output. A tool whose result carries images (a Read of an image file, a browser screenshot, an MCP tool) shows them as thumbnails with a click-to-enlarge lightbox, including for subagent and team tools and after a reload. Read overlays show a file metadata card with line range, total lines, and a progress bar for partial reads. Cron tool overlays show human-readable schedules, job IDs, recurring/one-shot badges, and job lists.

## Streaming responses

Responses render as they are generated. The text types out at least 200 characters a second and speeds up to stay about half a second behind the model. It appears as it arrives when reduced motion is on: the system setting, VS Code's `workbench.reduceMotion` or `damocles.desktop.reduceMotion`.

## While the agent works

- **Message queue.** Send messages while the agent is working. Each shows as a chip, and everything queued reaches the agent together at its next tool boundary. ESC, the budget limit stopping the turn, a new chat, approving a plan that clears the context, a folder switch or resuming another conversation in the chat puts undelivered messages back in the input box, images included. A UserPromptSubmit hook checks each queued message once, when you queue it, and a message it blocks leaves the queue with the hook's reason shown.
- **Parked session indicator.** A session waiting on you reads as waiting, not as working. A run parked on a tool approval, an `AskUserQuestion`, a browser input request, a plan or skill approval, or an MCP elicitation shows a pulsing warning indicator and returns to working the moment you answer, including for a dialog raised by a team agent.
- **Side questions (`/btw`).** Ask ephemeral side questions that share conversation context without interrupting the main session. Prompt caching means only the question and response are new tokens. Responses appear in dismissable inline aside bubbles with markdown rendering, visually distinct from the main conversation. They are not persisted to session history.

## Prompt history and navigator

- **Prompt history.** Navigate previous prompts with the arrow keys, shell-style.
- **Prompt navigator.** `Ctrl+K` / `Cmd+K` opens a searchable overlay listing every user prompt in the active session. Each row shows index, time, tools invoked during the response, and a kebab menu with Copy / Use as draft / Rewind to here. Type to fuzzy-match prompt text or tool names; arrow keys navigate, Enter jumps to the bubble in the canvas (with a primary-color flash ring), Escape closes. The header chip shows the live prompt count plus the platform-correct keybind (`⌘K` on macOS, `Ctrl+K` elsewhere). Each user bubble also exposes the same actions via a hover-revealed kebab, so mid-canvas navigation never requires the overlay.

## Sessions

Create, rename, tag, resume, delete, and search sessions with confirmation. Names and tags persist as in-tree session markers; tags show as badges in the chat header's session history in VS Code and in the sidebar's Chats list in the desktop app. A conversation is open in one panel at a time: opening one that another panel already shows switches to that panel. Deleting a session also removes its plan files and its subagent and team data.

**Session logs.** The log button in the status strip, or Session log in the chat header's More menu, opens the raw JSONL session file. Each subagent and team member has its own pi session file in a folder named after the parent session, opened from its card's "Open agent log" or the team card's log link. An agent writes its file once it receives its task.

## Context stats

The status strip under the message box shows the context window % as a ring, prompt tokens (uncached input, cache read and cache write in the tooltip), output tokens, cache hit rate, turn count and the conversation's total cost. The totals include stopped turns, compactions and cache warming, and a fork counts only what it spent after the fork. Subagent and team spend shows on their own cards. Tokens with no recorded price read "unpriced" rather than $0.00. Context % reflects the last completed request's occupancy (its input + cache).

Clicking the ring opens a menu with Compact now and View details. View details opens the Context Usage Overlay, also reachable via `/context`. It is a full-screen view with:

- an SVG ring chart, a stacked category bar and a per-category breakdown
- a collapsible message breakdown (user/assistant/tool calls/results/attachments with per-type drilldowns)
- detail sections for MCP tools, memory files, agents, system prompt sections, system tools, deferred tools, skills, and slash commands
- an auto-compact threshold badge reading the threshold in force for the active model
- an API usage footer

The system prompt breaks into one row per prompt section (Preamble, Memory, Plan mode, Plan file, Team directive, Project context, Skills, Tone, as each applies), each with its own token cost; hovering a row shows the raw section name. Every tool row is costed by its description **plus** its serialized schema, and each is badged **Loaded** or **Deferred**. The `Tools (deferred)` category is what deferral is saving rather than context you are spending, so it is shown muted and excluded from the stacked bar, which continues to sum to the headline total. Every list is sorted alphabetically (locale-aware, so it follows your active language) rather than by discovery order, so an entry stays where you last found it. The System prompt row and each MCP tool row open their full text, which the desktop app shows read-only in the chat's editor.

## Subscription usage

`/usage` opens an overlay with a progress bar per rate-limit window for both providers: Claude (session/5-hour, weekly, and the current model-scoped weekly) and ChatGPT/Codex (5-hour + weekly on premium, or a single monthly window on free), each with a live "resets in" countdown, plus extra-usage/credit spend and a GPT plan badge when available. When ChatGPT's usage endpoint does not accept a Sign in with ChatGPT token, the GPT section links to `chatgpt.com/settings/usage` instead.

The Claude section also shows an **Account** block read from Anthropic's `/api/oauth/profile`: plan, seat tier, rate-limit tier, subscription status and whether extra usage is on, with your email and organization name masked until you click them (the reveal is never saved and resets when the overlay closes).

Usage is read live from each provider's endpoints via your existing subscription OAuth; an API-key login sends no request, and access tokens and your email are never logged. The overlay opens mid-stream and refreshes on demand.

## Usage statistics

`/stats` opens an overlay with spend across every project: API-equivalent cost, total and output tokens, cache hit rate, net cache savings, sessions and active days, each with its formula in a tooltip. Filter by preset or custom date range, model and project, and compare against the previous period.

- A stacked chart shows cost or tokens per day, week or month by model or token type.
- Tables break spend down by model, project and source (main chat, subagents, teams, compaction, cache warming, background tasks).
- A weekday by hour grid shows when you work.
- The ten costliest conversations open on click.

Figures come from the session files plus a ledger of internal requests (titles, memory, `/btw`) in `~/.damocles/usage/`, indexed by a worker thread so the first scan does not block the editor. A deleted conversation's spend stays in the totals without its title.
