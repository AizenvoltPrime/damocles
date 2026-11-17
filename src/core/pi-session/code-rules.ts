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
 * The bound on re-runs is that an unchanged tree returns the same answer. Callers append to this body
 * rather than restate it: team specialists add the fingerprinted ledger, replace-mode writers a line
 * that puts it above their role description's test cadence.
 */
export const TEST_RUN_RULES_BODY: string = `A test run costs the user time and some suites take minutes, so run one only when its result can change what you do next. Read the code to learn what it does; a run only tells you whether it passes.
 - Run the narrowest command that covers your change: the test file or test name, not the suite. Run a whole suite once, at the end of a change set, or when the project's workflow asks for it.
 - Make a set of related edits, then run once. A run on a tree you have not changed since gives the same answer, so cite it. Edits to comments, docs or unrelated config cannot change a result.
 - When a run fails, read its output (for a browser test, its trace or screenshot) and change something before you run again. Reproduce the failure with the fastest test that shows it, a unit test before a browser test, and return to the wider command once, after it passes.
 - Send long output to a log file once and search the file, rather than running the command again to see another part of it.
 - Use the project's single-run command. Watch mode never exits and blocks the session.`;

/** Where a role description (a bundled profile, a team specialist's domain) carries its own test cadence. */
export const TEST_CADENCE_PRECEDENCE: string =
  "These rules replace the testing cadence in your role description. Your task's instructions about which tests to run still apply.";
