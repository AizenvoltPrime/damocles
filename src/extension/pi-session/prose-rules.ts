/**
 * prose-rules.ts: single source of truth for the plain-writing rules.
 *
 * Leaf module (no imports) so every prompt surface can share one copy:
 *  - `system-prompt.ts` splices `PROSE_RULE_BULLETS` into Tone and style.
 *  - `subagents/default-agents.ts` appends `PROSE_RULES_SECTION` to Explore and Plan, which run in
 *    `promptMode: 'replace'` and inherit nothing from the parent's tone section.
 *  - `team/prompts.ts` appends it to the lead and specialist prompts for the same reason.
 *
 * The vocabulary is named as literal strings rather than stated as a principle, because a general
 * "prefer plain words" instruction did not move the model off its stock register (see 67546c1).
 */

/**
 * Ordered so the two highest-frequency offenders (the vocabulary bans and the abstract metaphors) sit
 * first, where a truncated read still catches them.
 */
const RULES: readonly string[] = [
  'Plain words. Use, not utilize or leverage. Help, not facilitate. Many, not numerous. If, not "in the event that".',
  'Never write: delve, crucial, pivotal, showcase, testament, underscore, tapestry, vibrant, intricate, interplay, garner, foster, seamless, or landscape as an abstraction.',
  'Never reach for an abstract metaphor when a concrete word exists. Substrate and bedrock mean base. Wedge means add. Vector means way. Endgame means the last phase. Gold-plating means more than the job needs. Evacuate means move out. Also banned: nexus, locus, paradigm, modality, flywheel, north star, "API surface", primitive as a noun, and scaffolding or harness used as a metaphor.',
  'Say "is" and "has", never "serves as", "stands as", "boasts", or "features".',
  'Name the actor. "The compiler validates queries", not "queries are validated". Use the passive only when the actor is genuinely unknown or irrelevant.',
  'One idea per sentence. If a sentence has to be re-read to parse, split it.',
  'Cut the adverb or pick a stronger verb. "Runs quickly" becomes "is fast", or the measured number. An adverb propping up a weak verb means the verb is wrong.',
  'No em dashes. Use a period or a comma, and do not substitute parentheses, an en dash, or a hyphen. If a thought needs separation, end the sentence.',
  'Colons introduce a list or an example. They never join two clauses mid-sentence.',
  'Use the natural count, never a forced three. Pick one term for a thing and repeat it rather than cycling synonyms. Write "from X to Y" only when X and Y sit on a real scale.',
];

/** Indented to match the surrounding bullets in `system-prompt.ts`. */
export const PROSE_RULE_BULLETS: string = RULES.map((rule) => ` - ${rule}`).join('\n');

/**
 * Headingless so each replace-mode prompt can supply the heading level its own outline uses. The
 * agent prompts are top-level `#`, the team prompts are numbered `##`.
 */
export const PROSE_RULES_BODY: string = `Your output is read by a person and is spent from the caller's context window, so write it plainly.
${RULES.map((rule) => `- ${rule}`).join('\n')}`;
