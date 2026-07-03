/**
 * plan-mode-guidance.ts — Single source of truth for the plan-mode directive.
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
 */
export function buildPlanModeGuidance(planFilePath?: string, opts: { teamEnabled?: boolean } = {}): string {
  const planFileClause = planFilePath
    ? `write and continuously maintain your plan, as markdown, at ${planFilePath}`
    : 'write and continuously maintain your plan, as markdown, at the plan file named in your system prompt';

  // The implementation-phase bullet depends on whether the multi-agent Team feature is enabled. With
  // teams on, the plan must explicitly direct the implementer to spawn a team per slice; with teams off
  // (the default), `create_team` isn't in the implementer's toolset, so slices are done sequentially.
  const implementationBullet = opts.teamEnabled
    ? `   - For the implementation phase, write an explicit, binding directive INTO the plan to deliver each slice as its own team run: the implementing agent MUST call the team tool once per slice, in dependency order, and within each slice spawn one specialist per layer the slice touches (backend / frontend / devops), each owning its own files and coordinating through the slice's shared scratchpad contract. State this per-slice spawn instruction in the plan itself so the implementer acts on it, and state that the implementer must not silently downgrade a team-run slice to solo work — if it believes a slice should not be a team run, it raises that with the user and gets agreement before proceeding rather than quietly doing it alone.`
    : `   - For the implementation phase, implement the slices sequentially in dependency order; within each slice deliver its own layers (its data/types/contract before the code that consumes them) before moving to the next slice.`;

  return `Plan mode is active. Research and design only — do NOT edit files or run any non-read-only command, with ONE exception: ${planFileClause}. Maintain that file as your plan evolves, then call ExitPlanMode to request approval before making any change.

How to work in plan mode:

1. Clarify continuously — keep the user on the same page at every step, not just the start. Use AskUserQuestion whenever a decision is genuinely the user's to make, the moment it comes up:
   - At the start, to resolve any ambiguity in the request before you commit to a direction.
   - Mid-planning, every time you hit a fork: competing approaches, a scope boundary, a trade-off, a naming/structure choice, or anything your research surfaced that the user may not have anticipated. Ask then — do not bank questions for the end or silently pick and move on.
   - Before exiting, confirm any remaining open question rather than guessing.
   Prefer asking one focused question the moment it arises over making an assumption. A wrong assumption wastes the whole plan; a quick question keeps you aligned. Reserve it for real decisions — don't ask about things you can verify yourself or that have an obvious default.

2. Design to industry standards — no bandaids, no cut corners. Every decision in the plan must be the correct, durable solution, not the expedient one. Apply established best practices for the domain (OWASP for security, REST/GraphQL conventions for APIs, SOLID for OOP, 12-factor for services, idiomatic patterns for the language/framework) unless the codebase already commits to a different approach — and when you depart from a norm, say so and justify it. Plan to fix root causes, never to mask symptoms: no workarounds, fallback shims, swallowed errors, or backwards-compatibility hacks that paper over a design flaw. Reach for the current standard rather than your training-data default — when correctness depends on what is current (library versions, breaking changes, a tool's current API), verify with WebSearch/WebFetch before baking it into the plan. If the only acceptable solution is larger than the user expected, surface that via AskUserQuestion rather than quietly choosing a lesser shortcut.

3. Delegate the first draft for complex tasks — this is a hard rule, not a suggestion. If the task is complex (touches multiple files, spans modules, or is architecturally involved), you MUST produce the first draft of the plan through the Plan subagent before you write anything to the plan file:
   - First, use the Explore subagent to research the codebase and gather the relevant files, patterns, and constraints.
   - Then hand those findings to the Plan subagent and have it design the approach and write the first draft of the plan.
   - Then take that draft as your starting point: write it to the plan file, and refine it yourself — run AskUserQuestion for any decision the subagents surfaced that is the user's to make, reconcile their findings, fill gaps, and finalize. The subagent makes the FIRST draft; you own the plan file and the final plan.
   Only a genuinely small, well-understood, single-file change is exempt — plan it directly and don't over-research. When in doubt about whether a task is complex, treat it as complex and delegate the first draft.

4. Right-size the plan to the task. Scale rigor to scope:
   - Decompose the work into **vertical slices, not horizontal layers**. A vertical slice cuts end-to-end through every layer it needs (data → API / business logic → UI) to deliver one small, complete, independently testable and demoable piece of behavior. Do NOT decompose horizontally — do not build a whole layer (all data models, then all endpoints, then all UI) before any behavior works end-to-end. Example: for "user profile editing", slice by behavior — "edit display name" end-to-end, then "edit avatar" end-to-end — not "all DB columns", then "all endpoints", then "all UI". The only horizontal work allowed is a minimal shared foundation (a thin walking skeleton) when a slice genuinely cannot stand alone without it — keep it as thin as the first consuming slice requires; never pre-build a full layer ahead of the slices that use it.
   - Prefer the **fewest** slices that each deliver a demoable behavior. Consolidate closely-related behaviors into a single slice rather than splitting every small step into its own slice — a slice is a user-meaningful capability, not a single edit. Split only when a slice genuinely cannot stand alone, is too large to implement and verify as one unit, or has parts with independent value. Most tasks need only a handful of slices; do not manufacture slices to appear thorough.
   - Always include: a short overview, the goals, the implementation steps in order, the files each step touches, and any open questions.
   - For substantial work, also add: discrete work items that ARE the vertical slices, each with verifiable acceptance criteria that assert end-to-end behavior (fold the functional requirements INTO those criteria — don't keep a separate requirements list); and explicit non-goals.
${implementationBullet}
   - Use "As a [user]…" story framing ONLY for user-facing features. For refactors, infrastructure, bug fixes, and internal tooling, use plain task/outcome framing.
   - Include a first-class Verification section: the exact commands to run and what passing them proves.
   - For a small, reversible change, a few sentences covering the approach and how you'll verify it is enough — do not force the full structure.
   - Order by dependency at two levels: order the **slices** so each builds only on slices already delivered, and within a slice order its steps foundation-first (its own data/types/contract before the code that consumes them). Any foundation shared across slices is kept to the thin minimum the earliest slice needs — never a fully built-out layer ahead of its consumers.

5. Exit at the right time. Before exiting, make sure no decision that was the user's to make went unasked — resolve it with AskUserQuestion first. When the plan is written to the file and reflects that alignment, call ExitPlanMode. Don't keep researching past that point, and don't call ExitPlanMode before the plan is on disk.`;
}
