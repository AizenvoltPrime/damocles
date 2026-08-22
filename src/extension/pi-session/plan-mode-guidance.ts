/**
 * plan-mode-guidance.ts: single source of truth for the plan-mode directive.
 *
 * Leaf module (no other pi-session imports) so both consumers can share it without an
 * `agent-start ↔ tools/` import cycle:
 *  - `agent-start.ts` appends it to the system prompt when a turn STARTS in plan mode (the path is
 *    known, so it is named concretely).
 *  - `tools/plan-mode-tools.ts` returns it as the `EnterPlanMode` tool result when the model enters
 *    plan mode MID-turn (that turn's system prompt predates plan mode, so the tool result is the only
 *    guidance the model gets this turn).
 *
 * Both paths emit identical guidance; only the plan-file clause differs by whether the path is known.
 * The text is cache-stable per session (no per-turn-varying content beyond the plan path).
 */

/**
 * Build the adaptive plan-mode guidance. When `planFilePath` is provided it is named concretely;
 * otherwise the model is pointed at the plan file named in its system prompt (the subagent path, which
 * has no path getter wired).
 *
 * `opts` carries capability flags only; this builder stays PURE (it never reads workspace config), so
 * both consumers can be tested on either branch without a VS Code host.
 */
export function buildPlanModeGuidance(
  planFilePath?: string,
  opts: { teamEnabled?: boolean; webSearchEnabled?: boolean } = {},
): string {
  const planFileClause = planFilePath
    ? `write and continuously maintain your plan, as markdown, at ${planFilePath}`
    : 'write and continuously maintain your plan, as markdown, at the plan file named in your system prompt';

  // The implementation-phase bullet depends on whether the multi-agent Team feature is enabled. With
  // teams on, the plan must explicitly direct the implementer to spawn a team per slice; with teams off
  // (the default), `create_team` isn't in the implementer's toolset, so slices are done sequentially.
  const implementationBullet = opts.teamEnabled
    ? `   - For the implementation phase, write an explicit, binding directive INTO the plan to deliver each slice as its own team run: the implementing agent MUST call the team tool once per slice, in dependency order, and within each slice spawn one specialist per layer the slice touches (backend / frontend / devops), each owning its own files and coordinating through the slice's shared scratchpad contract. Direct the implementer to pass each slice's spec / acceptance criteria as the create_team \`brief\` argument (per that tool's description). State this per-slice spawn instruction in the plan itself so the implementer acts on it, and state that the implementer must not silently downgrade a team-run slice to solo work. If it believes a slice should not be a team run, it raises that with the user and gets agreement before proceeding rather than quietly doing it alone.`
    : `   - For the implementation phase, implement the slices sequentially in dependency order; within each slice deliver its own layers (its data/types/contract before the code that consumes them) before moving to the next slice.`;

  // `damocles.pi.webSearch.enabled` is off by default, and while it is off the web tools are not in the
  // session's eligible set at all. `ToolSearch({tools:["web"]})` answers "Not available in this
  // session". Emitting the clause unconditionally therefore spends a turn sending the model after a
  // capability it does not have, so the guidance is gated on the capability exactly as the browser
  // clause above it is.
  //
  // Clause ORDER is the requirement, not mere presence, and it matches the browser clause: the load
  // step LEADS, the prescription follows. A model that reads "verify with the web tools" before it
  // reads "they are not loaded yet" has already made the failing call. The load step only prevents
  // the unknown-tool error if the model encounters it first.
  const webVerificationClause = opts.webSearchEnabled
    ? ` The web tools are NOT loaded at the start of your turn: when correctness depends on what is current (library versions, breaking changes, a tool's current API), call \`ToolSearch({tools:["web"]})\` first. WebSearch/WebFetch are callable from your next step. Then verify with the web tools before baking it into the plan.`
    : '';

  return `Plan mode is active. Research and design only. Do NOT edit files. You MAY run read-only shell commands (git status/log/diff/show, ls, cat, grep, find, head, tail, …); \`cd <dir> && <read-only command>\` works, and you may discard output with \`2>/dev/null\`, \`>/dev/null\`, or \`>/dev/null 2>&1\`. Every other redirection is blocked, as is any command not positively recognized as read-only, so keep shell usage to plain reads. The browser tools are NOT loaded at the start of your turn: when the integrated browser is enabled and a question is only answerable against a live page or running app, call \`ToolSearch({tools:["browser"]})\` first. They are callable from your next step. Then prefer the read-only inspections (BrowserOpen, BrowserNavigate, BrowserSnapshot, BrowserQuery, BrowserScreenshot, BrowserConsole, BrowserNetwork, BrowserAccessibility), and never type credentials yourself. Ask the user via BrowserRequestInput. The ONE write exception: ${planFileClause}. Maintain that file as your plan evolves, then call ExitPlanMode to request approval before making any change.

How to work in plan mode:

1. Clarify continuously. Keep the user on the same page at every step, not just the start. Use AskUserQuestion whenever a decision is genuinely the user's to make, the moment it comes up:
   - At the start, to resolve any ambiguity in the request before you commit to a direction.
   - Mid-planning, at each fork: competing approaches, a scope boundary, a trade-off, a naming/structure choice, or anything your research surfaced that the user may not have anticipated.
   - Before exiting, confirm any remaining open question rather than guessing.
   Ask one focused question as it arises rather than banking questions for the end, because a wrong assumption wastes the whole plan. Reserve it for real decisions, and don't ask about things you can verify yourself or that have an obvious default.

2. Design to industry standards, with no bandaids and no cut corners. Every decision in the plan must be the correct, durable solution, not the expedient one. Apply established best practices for the domain (OWASP for security, REST/GraphQL conventions for APIs, SOLID for OOP, 12-factor for services, idiomatic patterns for the language/framework) unless the codebase already commits to a different approach. When you depart from a norm, say so and justify it. Plan to fix root causes, never to mask symptoms: no workarounds, fallback shims, swallowed errors, or backwards-compatibility hacks that paper over a design flaw. Reach for the current standard rather than your training-data default.${webVerificationClause} If the only acceptable solution is larger than the user expected, surface that via AskUserQuestion rather than quietly choosing a lesser shortcut.

3. Delegate the first draft for complex tasks. This is a hard rule, not a suggestion. If the task is complex (touches multiple files, spans modules, or is architecturally involved), you MUST produce the first draft of the plan through the Plan subagent before you write anything to the plan file:
   - Orient yourself first with a few targeted greps/reads, then send the Explore subagent after the depth you still lack, stating what you already established as known facts it must build on, not re-derive. A seeded delegation comes back with the specifics you need; a cold "go research X" comes back with the summary you already had.
   - Then hand those findings to the Plan subagent and have it design the approach and write the first draft of the plan.
   - Then take that draft as your starting point: write it to the plan file, and refine it yourself. Run AskUserQuestion for any decision the subagents surfaced that is the user's to make, reconcile their findings, fill gaps, and finalize. The subagent makes the FIRST draft; you own the plan file and the final plan.
   Only a genuinely small, well-understood, single-file change is exempt, so plan it directly and don't over-research. When in doubt about whether a task is complex, treat it as complex and delegate the first draft.

4. Right-size the plan to the task. Scale rigor to scope:
   - Decompose the work into **vertical slices, not horizontal layers**. A vertical slice cuts end-to-end through every layer it needs (data → API / business logic → UI) to deliver one small, complete, independently testable and demoable piece of behavior. Do NOT decompose horizontally. Do not build a whole layer (all data models, then all endpoints, then all UI) before any behavior works end-to-end. Example: for "user profile editing", slice by behavior, so "edit display name" end-to-end, then "edit avatar" end-to-end, not "all DB columns", then "all endpoints", then "all UI". The only horizontal work allowed is a minimal shared foundation (a thin walking skeleton) when a slice genuinely cannot stand alone without it. Keep it as thin as the first consuming slice requires; never pre-build a full layer ahead of the slices that use it.
   - Prefer the **fewest** slices that each deliver a demoable behavior. Consolidate closely-related behaviors into a single slice rather than splitting every small step into its own slice. A slice is a user-meaningful capability, not a single edit. Split only when a slice genuinely cannot stand alone, is too large to implement and verify as one unit, or has parts with independent value. Most tasks need only a handful of slices; do not manufacture slices to appear thorough.
   - Always include: a short overview, the goals, the implementation steps in order, the files each step touches, and any open questions.
   - For substantial work, also add: discrete work items that ARE the vertical slices, each with verifiable acceptance criteria that assert end-to-end behavior (fold the functional requirements INTO those criteria, and don't keep a separate requirements list); and explicit non-goals.
${implementationBullet}
   - Use "As a [user]…" story framing ONLY for user-facing features. For refactors, infrastructure, bug fixes, and internal tooling, use plain task/outcome framing.
   - Include a first-class Verification section: the exact commands to run and what passing them proves.
   - For a small, reversible change, a few sentences covering the approach and how you'll verify it is enough, so do not force the full structure.
   - Order by dependency at two levels: order the **slices** so each builds only on slices already delivered, and within a slice order its steps foundation-first (its own data/types/contract before the code that consumes them). Any foundation shared across slices is kept to the thin minimum the earliest slice needs, never a fully built-out layer ahead of its consumers.

5. Exit at the right time. Before exiting, make sure no decision that was the user's to make went unasked. Resolve it with AskUserQuestion first. When the plan is written to the file and reflects that alignment, call ExitPlanMode. Don't keep researching past that point, and don't call ExitPlanMode before the plan is on disk.`;
}
