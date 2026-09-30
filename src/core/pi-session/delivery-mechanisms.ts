/**
 * delivery-mechanisms.ts: the one source for the delivery-mechanism ladder.
 *
 * Four prompt surfaces state the same choice (do it yourself, one specialist subagent, a team) to four
 * different readers: the plan-mode guidance, the Plan subagent's block, the main session guidance and
 * the execution-time directive. They are built in four modules that cannot import one another, so the
 * shared sentences live here and every surface composes them. Hand-copied prose in four places drifts,
 * which is what the `create_team`/`Use as few teams` wording already started to do.
 *
 * Leaf module: imports nothing, so any prompt builder can take it without an import cycle.
 *
 * Every rung is gated on the reader's real capability at the call site. A prompt that names
 * `create_team` to a session whose toolset lacks it sends the model after a tool it cannot call.
 */

/** Named wherever the specialist rung appears, so one list of examples serves every surface. */
const SPECIALIST_EXAMPLES = '`Frontend Developer`, `Backend Architect`, `Test Automation Engineer`';

/** The cases that justify a team, stated once. */
const TEAM_CASES =
  'a security-sensitive change, a cross-cutting redesign, or a change whose correctness is contested';

/** The labels a plan records per slice, which `planExecutionDirective` later reads back. `team` is
 *  offered only when the implementer can start one, so the planner never assigns an unreachable one. */
export function mechanismLabels(teamEnabled: boolean): string {
  return teamEnabled ? 'direct, specialist or team' : 'direct or specialist';
}

/**
 * The rungs as a PLANNER assigns them to a slice, smallest first. Rendered as a bullet list by the
 * Plan agent's block and joined into prose by the plan-mode guidance, so each is a standalone sentence.
 */
export function sliceMechanismRungs(teamEnabled: boolean): string[] {
  const rungs = [
    'Direct implementation when the slice is a handful of edits in the files the plan already names, because delegating costs more than the fix.',
    `One specialist subagent (\`Agent\` with the \`subagent_type\` matching the subsystem, e.g. ${SPECIALIST_EXAMPLES}) when the slice is focused but large enough to be worth the handoff, or when its result set would bloat the implementer's context.`,
  ];
  if (teamEnabled) {
    rungs.push(
      `A team (\`create_team\`, one specialist per layer the slice touches, each owning its own files and coordinating through the slice's shared scratchpad) only when the slice genuinely needs several perspectives at once or an independent reviewer: ${TEAM_CASES}. Use as few teams as the work allows, and have the implementer pass the slice's spec and acceptance criteria as the create_team \`brief\` argument.`,
    );
  }
  return rungs;
}

/** What the plan records per slice, and how binding it is on the implementer. */
export function mechanismRecordRule(teamEnabled: boolean): string {
  return `Record each slice's mechanism as one of ${mechanismLabels(teamEnabled)}, plus a one-line reason. State in the plan that the assignments are a recommendation: the implementer may pick a different mechanism when the work turns out different from what the plan assumed, and says which slice, which mechanism, and why, in its next message, when it does.`;
}

/**
 * The same ladder for an agent choosing how to do the job in front of it, rather than assigning a
 * mechanism to a slice it is planning. One bullet for the main session guidance.
 */
export function sessionMechanismBullet(teamEnabled: boolean): string {
  const teamClause = teamEnabled
    ? ` Start a team (\`create_team\`) only when a job genuinely needs several perspectives at once or an independent reviewer: ${TEAM_CASES}. Give each team a \`brief\` scoped to its job, and use as few teams as the work allows.`
    : '';
  return ` - Pick the smallest delivery mechanism that fits the job. Your own edits are the cheapest for a small job, and one specialist subagent is the cheaper answer for a focused one.${teamClause}`;
}
