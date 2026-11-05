# Plan mode

This page covers plan mode: how the agent writes and maintains a plan, what it may run while planning, how you approve the plan, and how to bind your own plan file to a session.

## How plan mode works

When plan mode is enabled, the agent creates implementation plans for your approval before making changes. Plans are decomposed into **vertical slices**, each cutting end-to-end through every layer to deliver one small, independently testable behavior rather than horizontal layers.

Review plans in a modal, approve with auto-accept or manual mode, or request revisions with feedback. Dismissing the overlay (Escape) hides it without canceling. Click the tool card to reopen, or press Escape again to reject.

Plan mode deterministically funnels every turn through `ExitPlanMode`: if the agent stops without exiting, it is automatically nudged to call `ExitPlanMode`, ask via `AskUserQuestion`, or keep planning, so a plan turn never ends silently without your approval. Press Stop or leave plan mode to break out.

## The plan file

While planning, the agent writes and continuously maintains its plan as markdown at a deterministic per-session path (`~/.damocles/plans/<slug>-<id8>.md`). This is the only native write permitted in plan mode.

That file is the single source of truth: the approval overlay, the saved plan, and the implementation handoff all read the full plan from it (approval is blocked until the plan file is written), and the completed plan card's **View plan** button opens it. View the session plan anytime from the chat header's Plan menu. In the desktop app the plan's Open in editor opens it editable, in local and remote chats, and approving hands the agent the version you saved.

## What runs while planning

- Read-only shell commands such as git status/log/diff, ls, cat, grep, and `cd`, plus stdout-only readers like `tac`/`rev`/`od`/`strings`/`base64`/`column`, run without asking. `cd <dir> && <read-only command>` works and output may be discarded with `2>/dev/null`, `>/dev/null`, or `>/dev/null 2>&1`.
- Any other shell command asks you first, or runs under YOLO, so the agent can query a service or read logs while planning.
- Every Edit/Write outside the plan file stays blocked, YOLO included.
- Enabled MCP tools remain fully available while planning, so the agent can still look things up (for example Context7 docs). The per-server enable/disable toggle is the control.
- The integrated browser's tools are available while planning too when `damocles.browser.enabled` is on, so research can drive a running app or a live page.

Plan mode's guarantee is no unapproved workspace writes and no unapproved shell, not "no side effects anywhere". It states what it *blocks* rather than re-listing what it permits, so a newly added tool subsystem is usable while planning by default.

## Clear context and auto-accept

A plan approval option clears conversation context and starts fresh with the plan injected (matching Claude Code CLI behavior). It preserves the planning session as reference while implementation runs in a clean session. The overlay header shows a context usage badge with threshold-based colors so you can make an informed decision.

## Binding a plan to a session

Inject a custom plan file into the session from the chat header's Plan menu › Bind a plan file…. It lists up to 8 markdown files in the chat's folder that sit in a `plans` folder or have the word "plan" in their name, newest first, and Browse for another file… opens the file dialog. Binding writes the plan to the session's deterministic plan-file path (overwriting an existing one in place, which the list warns about) and confirms with a toast. No agent turn is spent. The agent reads the plan from that path, which is injected into the system prompt every turn.
