/**
 * code-rules.ts: single source of truth for the comment policy and the test-run cadence.
 *
 * Leaf module (no imports), same role as `prose-rules.ts`: the panel prompt splices these into its own
 * `# Comments` and `# Running tests and checks` sections, and the surfaces that run in `promptMode:
 * 'replace'` (team lead, team specialists, the bundled agent profiles) pull the same bodies, because
 * they inherit nothing from the panel.
 *
 * Both bodies are headingless so each caller supplies the heading level its outline uses.
 */

/**
 * The earns/never-earns enumeration is what makes the rule actionable. It does not compress into a
 * single sentence without losing the cases, so every surface that can write code carries all of it.
 *
 * The design-doc pointer stays generic because the file name varies by project. A project that wants
 * its doc named literally says so in its own context file.
 */
export const COMMENT_RULES_BODY: string = `A comment states a constraint the next editor would otherwise violate, then stops. One line by default; two or three only when the constraint genuinely needs them. This standard is absolute: a heavily-commented file is not licence to add more, and existing walls of text are not a pattern to match.
 - Earns a comment: coupled constants that must stay equal, ordering requirements, platform or engine gotchas, ownership and authority rules, units and coordinate conventions, a bug workaround, what a magic number means, what a non-obvious test guards.
 - Never earns one: restating what the code does; change history ("used to say", "tried and removed"); arguments against alternatives you rejected; worked derivation tables; commented-out code; decorative banners; meta-commentary about the comment itself. Describe the code as it is now. Git holds the history.
 - Never reference the current task, fix, or callers. That rots.
 - Long derivations live in the project's design doc. Code carries a bare pointer to the section, never a paragraph summarising it, because a summary is a second copy that drifts.
 - In source: no warning glyphs, no ALL-CAPS shouting, no rhetorical framing ("the trap is", "which is exactly why").
 - When a premise becomes false, correct it everywhere it is asserted (source comments, rules files, design docs) in the same change.`;

/**
 * Counterweight to any "prove it before you claim it" rule, which on its own reads as a licence to
 * re-run anything at any time. The bound is that an unchanged tree returns the same answer. A team
 * specialist gets a stronger version of the same bound from the fingerprinted verification ledger, so
 * it appends the ledger mechanics to this body rather than restating it.
 */
export const TEST_RUN_RULES_BODY: string = `Run a test, type check, linter, or build when its result can change what you do next.
 - Run the narrowest command that answers the question: the one file or test name you touched, not the whole suite.
 - Save the full suite for the end of a change set and run it once, or when the project's workflow expects it before a commit.
 - One passing run is the evidence a done-claim needs. The same command over a tree you have not changed since returns the same answer, so cite that run instead of repeating it.
 - Editing comments, docs, or unrelated config cannot change a result. Don't re-run to confirm it.
 - When a run fails, fix the cause and re-run only what failed. Return to the wider command once, after it passes.
 - Read the code to learn how it behaves. A run tells you whether it still passes, not what it does.
 - Use the project's single-run command. Watch mode never exits and blocks the session.`;
