# Agents and teams

This page covers subagents, custom agent templates, background agents, steering and resuming agents, collaborative teams, and the MCP tools nested agents receive.

## Subagents

`Agent` tool calls render as a nested view showing agent type, model, tool calls, results, real-time progress summaries, and tokens, cost and cache hit rate that update after each response. Click the agent type or template badge to open its `.md` template. Background agents display a "Background" badge.

A subagent waiting for a free slot under `damocles.subagents.maxConcurrent` reads Pending, with no timer, until it starts. Stop on a subagent's card or in its overlay ends only that subagent, queued or running: the main agent receives its work so far, marked as stopped by you and resumable, and its turn goes on.

### Background tasks

The indicator pill in the status strip under the message box shows how many background subagents are running. It opens a list of their subagent cards, the same cards the chat shows, each with a Stop button while it runs and a Dismiss button once it ends. Click a card to open the subagent. Results appear as labeled assistant messages.

## Custom agents

Define custom agents in `.damocles/agents/*.md`, `.pi/agents/*.md` or `.claude/agents/*.md` (project) and `~/.damocles/agents/*.md`, `~/.pi/agent/agents/*.md` or `~/.claude/agents/*.md` (user). Project agents override user agents of the same name, and within one scope `.damocles` beats `.pi`, which beats `.claude`.

They run as native nested agents via the `Agent` / `GetSubagentResult` / `SteerSubagent` tools, alongside the built-in `general-purpose` / `Explore` / `Plan` agents. A `run_in_background: true` frontmatter default makes a template always spawn in the background.

### Model and effort

A subagent runs on **your active panel model** unless its template pins one with `model:`. A subagent on the panel model also runs at the panel's reasoning effort unless its template sets `thinking:`. The spawning agent never picks a model, so that choice stays configuration you control.

The `Explore` agent follows `damocles.explore.model`: Default runs it on your chat's small model at medium effort, and a model you pick there runs at the effort you set beside it; a picked model whose provider is signed out fails the spawn naming that setting.

A `model:` that doesn't resolve, isn't signed in, or falls outside the `enabledModels` allowlist fails the spawn and names the template to fix, rather than silently running on a different model.

### Read-only agents

An agent whose `tools:` list has no write tool (the built-in `Explore` and `Plan`, or your own) follows plan mode's shell rule in every permission mode: a provably read-only command runs, and anything else (a heredoc, `tee`, `cp`, `npm test`) asks you first, or runs under YOLO. "Read-only" bounds *writes*, not research: such an agent still gets the web tools, the integrated browser tools and your MCP tools (none is write-category), and the built-in `Explore`/`Plan` carry the full browser toolset when `damocles.browser.enabled` is on.

## Steering agents

Redirect a running or queued background subagent, or a live team member, mid-task with `/steer`. Pick the target from a live agent picker, type your instruction, and it becomes the agent's top priority immediately (it drops its current approach to follow it). A steer can carry pasted images, with or without text, but not browser elements.

The picker lists a team's lead and specialists with their team, role and status, including a member whose session is still opening; the lead sees a specialist's steers when it reviews that specialist. Your steer shows as an amber chip in the transcript and echoes inside the agent's live view. The model can steer its own subagents, but not team members, via the `SteerSubagent` tool.

## Resuming interrupted agents

A subagent or team stopped by ESC, a subagent's Stop button, Stop team, `cancel_team`, closing the panel, reloading the window or Damocles exiting unexpectedly picks up where it left off when you say "continue", and so does a team whose lead failed. Your next message tells the model which agents stopped, why (you stopped it, `cancel_team`, the panel closed or reloaded, Damocles exited, or the lead failed), and how to resume each (`Agent({resume})` for a subagent, `resume_team` for a team), and the model resumes only when you ask.

- A resumed subagent keeps its conversation, model, reasoning level and foreground or background mode, and its new card carries a "Resumed" badge.
- A resumed team restarts the lead and the specialists that were working, leaves specialists awaiting review parked, and delivers any message a member had not yet received.
- A subagent whose model call still failed after pi's retries tells the model its error, what it wrote before failing and how to resume it, and resumes the same way.

Damocles does not resume a subagent that the budget limit or a cleared conversation stopped, or an agent that finished. It offers no resume for a team whose lead failed to start, which would fail the same way.

## Collaborative teams

A multi-agent team system where 2-5 specialist agents collaborate in real time on complex tasks. A lead agent orchestrates by spawning specialists with domain expertise profiles, coordinating via direct messaging, sharing decisions on a scratchpad, and synthesizing a final result. Teams are disabled by default; enable them via `damocles.team.enabled`.

### Mission brief

`create_team` takes a required **`brief`** (the authoritative statement of what to build and why) alongside a short `title` label. The brief is seeded verbatim into an immutable `mission-brief` scratchpad section before any agent spawns, and the lead can't spawn a specialist until it has read it, so the authoritative intent always reaches the whole team instead of the lead inventing an architecture.

A specialist that finds anything in conflict with the brief **hard-stops** and flags it (`team_flag_brief_conflict`); the lead reconciles it (revise or dismiss-with-rationale) or escalates the fork to you via `AskUserQuestion`. A flagged conflict can never be silently dropped: synthesis is mechanically blocked while one is open, and any completion that still carries an unresolved conflict is prepended with a prominent "UNRESOLVED BRIEF CONFLICTS" warning block.

### Roles, models and effort

The lead spawns each specialist with a `kind` (`implementor` or `reviewer`) that selects which role settings apply. **You** choose the model and reasoning effort per role (lead / implementor / reviewer) via the six `damocles.team.*` settings. The AI never picks team models. Leave a model empty to use the active panel model, and leave an effort empty for the model default. Any catalog model works for any role, including across providers (for example reviewers on a different model than implementors); a role configured to a model whose provider isn't signed in fails team creation up front with a clear message naming the setting and model.

91 bundled agent profiles across 8 categories (Engineering, Design, Testing, Security, Product, Project Management, Specialized, Game Development) give specialists domain knowledge.

### Liveness

The engine guarantees liveness without timers:

- A specialist can't silently end its turn without reporting. It's nudged, then forced into review where the lead can revise or approve it.
- Messaging a dead or unspawned agent fails loudly with recovery guidance.
- The lead can re-run a failed or cancelled specialist with `team_redispatch_specialist` (same card, transcript preserved).
- A lead that abandons an open review round gets bounded re-notifications before the team force-completes with a clearly marked partial result.

A team run always returns.

### Coordination and cost

Agents don't interrupt each other: a scratchpad write wakes only a specialist parked in `standby`, while a working agent pulls shared state when it needs it. The Timeline still records every write. Both terminal tools end the turn from the engine rather than trusting the model to stop, so a parked specialist costs nothing until a teammate wakes it, and `team_report_complete` carries the sign-off as an argument instead of paying for an extra request to write one. Re-reading a scratchpad section at a version you already hold returns a short marker instead of its text. Each role is registered only for the tools it can call, 13 for the lead and 9 for a specialist.

Cost on each card is labelled by the model that agent actually ran on, and on a flat subscription it reads as an estimate (`~$0.42 est.`) rather than a charge.

A shared **verification ledger** (`team_record_verification`) lets one agent's test run count for the whole team: each entry is stamped with a fingerprint of the working tree that **Damocles computes from git**, never the agent, so a peer can skip a provably redundant run, and any edit changes the fingerprint, so a stale pass can never be reused. Cross-review follows the lead's contract, so specialists whose work never touches don't manufacture feedback for each other.

### Team cards and overlay

Each `create_team` and `resume_team` call gets its own TeamCard in chat, showing that run's status, time, tools, tokens, cache hit rate and cost, and only the running call's card is live. TeamOverlay provides full details (Agents, Timeline, Scratchpad, Result tabs). An agent waiting for your approval shows "Needs you" on its chip, the team card and the team view.

Stop team, on the running card and in the overlay, asks first and names the agents still working, then stops the whole team, leaving it resumable, and hands the main agent the partial results so its turn goes on; the lead's own Stop does the same.

Each agent's tool calls render as full cards with readable names (`Write scratchpad`, not `team_write_scratchpad`), live shell output and a Stop button, and they open into the tool overlay like any other card. All agent communication and every tool result is persisted to JSONL, so a team reopened from history shows what each tool returned. Each Damocles panel owns its own team runner, so multiple panels can run independent teams concurrently without cross-interference.

## MCP for subagents and team agents

Every nested agent gets the panel's full eligible MCP set, deferred like the panel's, and loads a server's tools with its own `ToolSearch`. The grant is **uniform**: `Explore`, a `tools: *` agent and a team specialist all get the same set, because MCP tool names depend on which servers *you* configured, so no template can name them without hardcoding something your config breaks. `disallowed_tools` is the opt-out (exact, case-sensitive).

An agent's set is **frozen at spawn**: a server connected mid-run reaches the next agent, not a running one, and a tool its server stops advertising is reported gone rather than worth retrying. The resource tools follow the same rule: an agent reaches the resource servers that were visible when it started, and `disallowed_tools: [read_mcp_resource]` removes that tool. A `mcp__<server>__read_mcp_resource(<uri pattern>)` entry in `disallowed_tools`, or in `damocles.tools.disabled` for every agent, turns off just the resources it names, in every mode, YOLO included. Read-only agents reach MCP under the panel's rules, so an annotated read-only tool runs, anything else asks you first.

See [MCP](mcp.md) for server configuration.
