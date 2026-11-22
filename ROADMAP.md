# Co-change gate: roadmap

Status: not started. Phase 0 decides whether the rest is built.

## Problem

An agent that edits one file often misses another file that has to change with it: a migration without its model, a tool file without its registration, a type without its serializer. Many of these pairs have no call or import edge, so Compass (`src/core/compass/`), which indexes only those edges, cannot name them.

## Idea

Git history records which files changed in the same commits. From it Damocles computes, for a file A, the files that usually change when A changes. When a run is about to end and the agent edited A but not such a file B, Damocles adds one hidden note naming B. The agent then gets one more request to edit B or to say why B needs no change.

Mining costs one `git log` per new commit and no model call. A wrong note costs one extra provider request.

## What this is not

- It is not a model of the system. It knows only pairs that changed together at least `minSupport` times, so it says nothing about a new kind of coupling or a young repository.
- It is a statistical guess. Phase 0 measures how often it is right before anything else is built.

## Decisions

| # | Decision | Reason |
| --- | --- | --- |
| 1 | The gate does not depend on Compass. It has its own module, `src/core/co-change/`, and its own cache file | Compass is off by default, so a gate behind it would reach almost no chat. The gate needs git and a small table, nothing Compass holds |
| 2 | The gate is on by default in a trusted folder, setting `damocles.coChangeGate.enabled` | A default-off feature is not found. The cost is bounded: no note without a stored pair, and at most one extra request per user turn |
| 3 | Mining never runs at the settle boundary. It runs in the background and the gate reads whatever cache is ready | Measured on this repository: `git log --name-only -n 1000` took 47 s cold and 1 s warm. A cold run at the boundary would stall the end of a run |
| 4 | Recall decides go or no-go, with false alarms only capped | A wrong note costs one request. A caught miss saves a bug and a round trip with the user. A gate that catches few misses is not worth a subsystem, however quiet it is |
| 5 | No new agent tool | Deferred tools load only through `ToolSearch`, so a prompt line cannot make the agent call one before finishing. The gate needs no call |
| 6 | Every fire is logged with its outcome | Without a count of notes that led to an edit, nobody can tell after a month whether to keep the gate |
| 7 | Thresholds are constants, not settings | Phase 0 picks them from data. A user has no basis to tune them |

Cut from the earlier draft, with no plan to return: the capability index (keyword search over model-written summaries: low recall, model cost, source sent out), the architecture digest (`CLAUDE.md`, `docs/invariants.md` and memory already carry it, and a block that changes each turn breaks the prompt-cache prefix), the three System Map tools, and the graph view.

## Rules for every phase

- **Scoring is per file and directional.** Keep `A -> B` when all three hold: A and B share at least `minSupport` commits (start at 3); `confidence = co(A,B) / total(A)` is at least `minConfidence` (start at 0.5); and `score = confidence * idf(B)` is above zero, where `idf(B) = log(totalFiles / distinctPartners(B))`. A lockfile that changes with everything gets an idf near zero.
- **Large commits are skipped.** A commit that touches more than `maxCommitFiles` files (start at 50) inside the folder is not counted. This repository has 587 commits: 78 are over the cap, 64 touch one file, and 445 carry signal.
- **Thin history means no data.** Below `minHistory` counted commits (start at 20) the gate behaves as if the cache were empty.
- **One key space.** A key is the file's path relative to the chat's working folder, with forward slashes, as `git log --relative` prints it. The gate's checkpoint diff must use the same spelling, and a test asserts both give the same key for one file.
- **Git.** The miner runs git as `compass/git.ts` `runGit` does (async `execFile`, spawn lock, `GIT_HARDENING_ARGS`), with its own 120 s timeout, and only in a trusted folder.
- **Failure is silent.** No git, a shallow clone, an empty history or a cache that is not ready gives no note. Nothing throws into a run.
- **The note is the model's text**, built with `english()`. No user-facing string is added.

## Phase 0: miner and replay measurement

Goal: a pure miner, and a number that says how often the gate would have been right on real history.

Work:

1. `src/core/co-change/miner.ts`: `mineCoChange(folder, opts)` runs `git log --name-only --relative -M --no-merges --pretty=format:%H -n <historyLimit> -- .`, splits the output into one file set per commit, drops commits over `maxCommitFiles`, and returns the directional records `{ source, target, support, confidence, score }` with the count of commits kept. `historyLimit` starts at 1000. The parsing and scoring are a separate pure function over the log text.
2. `scripts/co-change-replay.ts`: takes a repository path. It mines the older 80% of the kept commits and tests on the newer 20%:
   - **False-alarm rate.** For each test commit, seed the lookup with all of its files. The gate would fire if any target above the thresholds is outside the commit. The rate is the share of test commits where it fires.
   - **Recall.** For each test commit of 2 or more files, remove one file at a time and seed with the rest. A hit is the removed file among the targets. Recall is hits over trials.
   - It prints both numbers for a small grid of `minSupport` and `minConfidence`, and the time the pure function took.

Acceptance:

- On a hand-built 3-commit fixture the counts and scores match values computed by hand.
- A file present in every commit gets no inbound record.
- A pair that changes together one way only (B changes whenever A does, A rarely when B does) keeps `A -> B` and drops `B -> A`.
- Merge commits and commits over the cap are excluded. A folder below its repository's root yields only paths inside it.
- No git, an empty repository and a shallow clone return `{ records: [], commits: 0 }`.

Go or no-go: run the replay on this repository and on the IEMIS Laravel repository. On each, take the threshold pair with the highest recall among those with a false-alarm rate of at most 20%. Build the gate only if that recall is at least 30% on both. This repository's test set is about 90 commits, so its numbers are rough; the application repository carries more weight. The chosen pair becomes the constants. If the pure function takes over 50 ms on 1000 commits, Phase 1 runs it off the host thread.

Files: `src/core/co-change/miner.ts`, `src/core/co-change/__tests__/miner.test.ts`, `scripts/co-change-replay.ts`.

Verify: `npx vitest run src/core/co-change/__tests__/miner.test.ts`, `npm run typecheck`, `npm run lint`.

## Phase 1: cache and background refresh

Goal: the records for a folder are ready before a run ends, and follow new commits, with no work at the boundary.

Work:

1. `src/core/co-change/cache.ts`: one JSON file per folder under `~/.damocles/co-change/` (path from `paths.ts`, named by the folder hash scheme `compassIndexPath` uses), holding the HEAD hash, the commit count and the records. Written atomically.
2. `src/core/co-change/index.ts`: `CoChangeService`, one per folder runtime. `refresh()` reads `git rev-parse HEAD` and, when it differs from the cached hash, mines in the background and replaces the cache. One mine at a time per folder; a second call while one runs is dropped. `targets(paths)` answers from memory with the targets above the thresholds, or nothing under thin history or before the first mine ends.
3. `PiSession` calls `refresh()` at the start of each run, not awaited, when the setting is on and the folder is trusted.
4. The setting `damocles.coChangeGate.enabled` (default true) in `package.json` and, through `npm run generate:settings-schema`, the desktop schema.

Acceptance:

- A second `refresh()` with an unchanged HEAD runs no `git log`.
- A mine that fails or times out keeps the previous cache.
- `targets()` returns nothing in an untrusted folder, with the setting off, and under thin history.
- A file gone from history leaves no record after the next mine.
- A chat in a chat worktree mines its working folder and gets that folder's own cache.

Files: `src/core/co-change/cache.ts`, `index.ts`, `src/core/paths.ts`, `src/core/pi-session/pi-session.ts`, `package.json`, the generated settings schema, and tests.

Verify: the narrow test files, `npm run typecheck`, `npm run lint`.

## Phase 2: the gate

Goal: one hidden note, at most once per user turn, before the run settles.

How it fits the code: `PiSession.onBeforeSettle` (`pi-session/pi-session.ts`) returns at most one draft per boundary, in the order background keep-alive, design draft, plan-mode hold. The extension handler appends the draft as `{ entries: [...event.entries, draft], continue: true }`, and pi re-enters the boundary after the extra request. The gate is a fourth step, tried last.

Work:

1. `CheckpointService.peekChangedFiles()`: with a pending baseline (`pendingBaseline()`), it runs prepare, stage and `diffAgainst(beforeCommit)` under the folder repo's lock and commits nothing. It returns the changed paths, or an empty list with no baseline or on any failure. `takeAfterState` in `checkpoints/auto-checkpoint.ts` is the model, minus `commitIndex` and `updateRefs`.
2. `tryCoChangeGate(event)` in `PiSession`, called only when the three earlier steps gave no draft. It returns nothing when any of these hold:
   - the service has no records for the folder;
   - the chat is a design chat, or the mode is plan;
   - a stop was requested, the user has a message queued, or the last assistant message did not end with `stopReason === 'stop'` (the same checks `tryPlanModeHold` makes);
   - this turn's `event.context.contextMessages` already hold a note of `CO_CHANGE_NOTE_CUSTOM_TYPE`. This read is the once-per-turn guard, so no session field is added and a reload cannot fire it twice.

   Otherwise it peeks the changed files, asks `targets()`, removes the changed files from the answer, and for a non-empty rest returns `{ type: 'custom_message', customType: CO_CHANGE_NOTE_CUSTOM_TYPE, content, display: false }`. The content lists at most 5 files by score, each with the edited file it follows and the confidence, and asks the agent to change each one or state in one line why it needs no change.
3. Outcome log: at the next boundary of the turn, or at settle, the gate logs the named files and how many of them the run then changed.
4. The gate runs for the main chat only. Subagents and team members get no note.

Known limits:

- The checkpoint repository is shared by every chat of a folder, so the peeked diff also holds edits another chat or the user made during the turn. The note may then follow a file the agent did not edit.
- The peek stages the work tree once more per run. Staging is incremental, and the gate skips the peek when the service has no records.
- The cache follows HEAD at the start of the next run, so a pair that first reaches `minSupport` in the newest commit is known one run late.

Acceptance:

- A turn that edits A and skips a stored target B gets one extra request with the hidden note, and the transcript shows no bubble for it.
- At the next boundary of the same turn the gate returns nothing, whether the agent edited B, declined, or ignored the note, and the run settles.
- No note when another step already returned a draft, in plan mode, in a design chat, with the setting off, under thin history, or after a stop.
- `peekChangedFiles` creates no commit and no ref, sees files changed by a shell command, and returns an empty list without a baseline.
- `pi-run-state-reads.test.ts` still passes: the gate reads no pi run state.

Files: `pi-session/pi-session.ts`, `pi-session/checkpoint-service.ts`, `pi-session/checkpoints/auto-checkpoint.ts`, `src/core/co-change/note.ts` for the note text and the turn check, and tests beside each.

Verify: the narrow test files, `npm run typecheck`, `npm run lint`, then one manual run in the desktop app on a repository with a known pair.

## After shipping

After a month of use, read the outcome log. Keep the gate if at least one note in three led to an edit of a named file. Below that, raise `minConfidence` once and measure again, then remove the gate if it still fails.

A co-change section in `CompassBlastRadius` output is the only follow-up worth considering, and only if the log shows the gate earns its place.
