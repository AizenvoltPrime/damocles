/** Bump when USEFULNESS_RUBRIC changes meaning, so audit runs graded under an older rubric are identifiable. */
export const RUBRIC_VERSION = 1;

/**
 * The one usefulness standard every memory writer and grader applies: extraction, profile
 * maintenance and the quality audit.
 */
export const USEFULNESS_RUBRIC: string = `Usefulness test: would a future agent working in this scope act differently because of this memory? Keep it only if the answer is yes.

Include:
- Gotchas and pitfalls, with the cause (what breaks and why).
- Environment quirks of the machine, toolchain or services.
- Conventions the user or the project follows.
- Decisions with their rationale.
- Commands and procedures that are verified to work.
- User preferences about how the work is done.

Exclude:
- Progress and status: "X done", "slice B3 finished", "awaiting user logs", "not committed yet".
- Release notes, changelogs, version bumps, commit hashes, test counts and pass/fail tallies.
- Anything a future agent can read from the repository or its git history (file listings, what a file contains).
- Speculation, hypotheses that were not confirmed, and plans that may change.
- Personal, financial or other details unrelated to the work.

Kind by what the memory is, not how it is phrased:
- A preference is a working rule the user stated or confirmed about how the agent works with them: communication, review and approval, workflow, code style. Preferences are injected into every conversation in their scope, so one must hold whatever the task is.
- A technical procedure, a diagnosis or debugging order, a command sequence or a configuration for one tool or subsystem is a fact, even when worded as "prefer X" or "always do Y first".

Scope by subject, not by where the conversation happened:
- Facts about the machine or the user that hold across projects are global.
- Facts about one repository belong to that repository's workspace, even when discussed from another workspace's window.
- Facts that stay useful only for days (current focus, a temporary workaround) are episodes.
- Facts useful only within this conversation are session-scoped.

Good:
- "FeedRead parses RSS with linkedom's DOMParser('text/xml'), because parseHTML treats <link> as a void element and drops the link text." (a gotcha with its cause)
- "Run vitest from PowerShell, never with -u: -u rewrites CRLF inline snapshots and corrupts them." (a verified procedure and its reason)

Bad:
- "Damocles v2.35.0 released: commit 5d1c426, tag pushed." (release note; git history has it)
- "Slice B3 done: session list cached on disk." (progress log)
- "app/ contains 20 top-level folders: Console, Events, ..." (derivable from the repository)`;
