Update `README.md`, `CHANGELOG.md`, `CLAUDE.md` and the docs under `docs/` to match the currently staged changes. This command is the user's explicit request to edit those files.

## Read the change first

Run in parallel:

- `git diff --staged` (the only source of truth; ignore unstaged and untracked work)
- `git diff --staged --stat` to see the shape of the changeset
- `git log -5`, the top of each root doc and the sections of `docs/` that cover the touched areas, to match the house style rather than invent one

Read enough of the touched source to state what **behavior** changed. A diff tells you which lines moved; only the code tells you what a user or a future session now experiences. Do not document a change you could not trace to a behavior.

If the staged set is large, split the reading across parallel `Explore` subagents by subsystem, then write the docs yourself so one voice runs through every file.

## The bar for each file

Each file has a different reader, so the same change can belong in one and not the others. "No entry needed" is a correct outcome, and saying so beats padding.

| File | Reader | Include when |
| --- | --- | --- |
| `README.md` | Someone deciding whether to install, or looking for how to use a feature | A user-visible capability, setting, command, keybind or requirement appeared, changed or went away |
| `CHANGELOG.md` | Someone upgrading, asking "what changed and does it affect me" | Any user-observable difference, including a fix and a dependency move |
| `CLAUDE.md` | Every future agent session, on every turn | A session that lacks this line would make a wrong change |
| `docs/*.md` | A session sent there by a CLAUDE.md pointer before changing a subsystem, and the owner | A behavior, invariant, failure mode, decision or measurement the doc states changed |

An internal refactor with identical behavior earns nothing in any of them.

## README.md

- Edit the bullet or section that already covers the area. A second bullet about the same feature is the failure mode here.
- Feature bullets use `- **Name**: description`. Configuration, Authentication and Requirements have their own `##` sections; put settings and keys there, not in the feature list.
- Describe the end state, not the change. README has no history, so never write "now", "previously" or "as of".
- When a feature was removed or renamed, delete or rename its bullet in the same pass.

## CHANGELOG.md

Pick the target section before writing:

- Read the top `## [x.y.z]` heading and `package.json`'s `version`, then check `git tag --list "v<x.y.z>"`.
- **Not tagged:** that release is still open. Add to its `### Added` / `### Changed` / `### Fixed` subsection, creating the subsection if it is absent.
- **Already tagged:** open a new `## [<next>] - <YYYY-MM-DD>` heading above it, dated with `date +%F`, default the bump to the next minor, and bump `package.json` to the same version in the same pass. `.github/workflows/release.yml` extracts release notes by matching the tag version against the heading, so a heading that disagrees with `package.json` ships the wrong notes. Say which version you opened in your summary. An explicit version in `$ARGUMENTS` overrides the default.

Writing an entry:

- One bold lead sentence naming the user-visible change, then two to four sentences of prose. Match the entries already in the file.
- The prose says what was wrong or what the old behavior cost, then what happens now. A reader who hits the old behavior should recognize it.
- Name settings, tools, events and files by their exact identifiers.
- Never cite a number you did not measure. Sizes, counts and percentages come from a command you ran.
- One entry per user-visible change, not one per commit or per file.

## CLAUDE.md

CLAUDE.md is injected into every session, so every line costs tokens on every turn forever. Treat additions as expensive and removals as free.

Before adding a line, apply the test: **would a session that never reads this line make a wrong edit?** If the answer is no, the line does not go in. Curiosity, background, rationale and "good to know" all fail this test.

- Correct before you add. If the staged change made an existing line false (a renamed module, a changed command, a dropped invariant, a moved seam), fix that line. A stale line is worse than a missing one because it is trusted.
- Prefer editing an existing line to adding a neighbor. The invariants list is a list of rules, not a log.
- Net line count should stay flat or shrink. If your edit grows the file, name what you deleted or why nothing could be.
- What qualifies: a build or dev command, the module map, a seam or invariant an agent could violate without noticing, permission-mode behavior, a generated artifact that must be regenerated and committed.
- What does not: implementation detail, a bug's backstory, anything already discoverable by reading one file, and anything that belongs in `docs/invariants.md`. Rationale and failure modes live there; CLAUDE.md carries the rule and the pointer.
- An invariant bullet states the rule and the consequence of breaking it, in one or two sentences. No paragraph.

## docs/

Each fact lives in exactly one doc; a second copy drifts. `docs/invariants.md` holds the rationale and failure modes behind CLAUDE.md's rules, one `##` section per subsystem. The other files each own one topic.

- Edit the doc or section that owns the area. The docs describe the current code: state what it does now, never how it came to be. Git holds the history.
- When the change makes an assertion false, correct it in place, and everywhere else it is asserted (CLAUDE.md, README.md, source comments) in the same pass.
- Keep headings stable: CLAUDE.md cites them by name ("Memory injection" in `docs/invariants.md`). If a heading must change, update every citation to it.
- Keep each edit the smallest one that makes the doc true. Change the existing sentence, number or table row before adding a new one, and delete what the change made false rather than qualifying it.
- A new paragraph needs a new rule, failure mode, measurement or derivation behind it. A restatement, a summary of the diff or an explanation of the change does not earn one.
- Never cite a number you did not measure.

## Prose rules

These hold in every file: no em dashes, no puffery, no words like seamless, powerful or crucial. Name the actor and the mechanism. One idea per sentence. Sentence case headings. A sentence that would read the same in another project's docs says nothing about this one, so cut it.

## Finish

- Run `git diff -- README.md CHANGELOG.md CLAUDE.md docs/` and read your own edit as a reviewer would.
- Do not stage and do not commit. Leave the edits in the working tree.
- Report, briefly: what you changed in each file, with the net line change for each doc under `docs/`, and for each file you left alone, the one-line reason. If a doc grew, name what was added and why an existing line could not carry it. If you skipped something a reader might expect to see documented, say which and why.

$ARGUMENTS
