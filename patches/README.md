# Dependency patches

`npm install` and `npm ci` apply each `*.patch` here to `node_modules` through `patch-package` (the `postinstall` script, with `--error-on-fail --error-on-warn`), in the order of the number in its name. A patch names the exact version it was made against, so an install whose version differs fails until the patch is updated or deleted. `patch-package` does not undo a patch that changed or was removed, so after the patches change, reinstall with `npm ci`: an `npm install` over the old patched files fails. Builds ship the patched files: the VSIX, the desktop app and the server packages copy pi from `node_modules`.

Each patch carries a fix that upstream has not released yet. Delete a patch in the change that bumps the dependency to a release that contains its fix, and regenerate the remaining patches against the new version in the same change.

## Making the pi patches

The pi patches are generated from pi's build, never edited by hand. Each fix is a commit on a pi branch `damocles/1.5.2-<name>`, stacked on `v1.5.2` in the order of the patches; the `fix/<name>` branch named below carries the same fix on pi's main, for upstream. To make patch N, build `packages/coding-agent` at branch N, copy the `.js` and `.d.ts` files of its `dist` that differ from the published package into a scratch install of `@earendil-works/pi-coding-agent@1.5.2` that has patches 1 to N-1 applied, and run `npx patch-package @earendil-works/pi-coding-agent --append <name> --exclude "(\.map$|^package\.json$|^dist/bundle/)"`. Source maps and `dist/bundle` (the bundle of the `pi` command, which Damocles does not load) stay unpatched. Patch files keep LF line ends (`.gitattributes`).

The patches change these files of pi's `dist/core`, and pi's `dist/index.js`, with their `.d.ts` files:

- Lines added: `agent-session.js` (001, 002), `resolve-config-value.js` (003), `tools/read.js`, `tools/edit.js`, `tools/write.js`, `tools/path-utils.js` and `tools/file-mutation-queue.js` (004), `session-manager.js` (005), `tools/edit-diff.js` (006).
- Same line count: `auth-storage.js`, `model-registry.js`, `model-runtime.js` and `provider-composer.js` (003), `agent-session-runtime.js` (005), `dist/index.js` (006).
- Lines removed: `tools/edit.js` (006).

A `<file>.js:<line>` citation in Damocles' comments and docs refers to the published pi 1.5.2, not to the patched copy in `node_modules`.

## 001 concurrent-prompts

Two prompts that reach an idle session in the same tick both start a run, and the second fails with "Agent is already processing a prompt". `prompt()` now checks `isStreaming` again right before `_startRun()`, in the same tick as its synchronous start, and queues the prompt into the run the other prompt opened, by its `streamingBehavior`.

- Upstream: [earendil-works/pi#12186](https://github.com/earendil-works/pi/issues/12186), branch `fix/concurrent-prompts`.
- Damocles' test: `src/core/pi-session/__tests__/mid-run-queue.test.ts`, "returns both prompts ESC overtook in pi's hands: the first refused the run it would open after the run ended, and the one that queued into that run's start".

## 002 prestart-throw

A throw from `prompt()`'s `preflightResult("started")` left the session busy for good: later prompts failed and `abort()` and `waitForIdle()` never resolved. The throw now refuses the prompt: its run does not start, nothing is written to the session, its nextTurn messages wait for the next run, and `prompt()` rejects with the error. Damocles throws there to refuse a prompt that was stopped before its run started.

A prompt or a `sendCustomMessage` with `triggerTurn` made while `agent_settled` handlers run is deferred, and its call has already returned when it runs. pi now runs each deferred action on its own: one that fails, a refused prompt included, no longer rejects the `prompt()` or `sendCustomMessage()` of the run that settled, nor stops the actions deferred after it. pi reports its error as an extension error, except a throw from the deferred prompt's own `preflightResult`, which is its caller's.

- Upstream: [earendil-works/pi#11065](https://github.com/earendil-works/pi/issues/11065), branch `fix/prestart-throw`.

## 003 async-config-commands

`!command` API keys and headers in `models.json`, and `!command` keys in `auth.json`, ran with `spawnSync` or `execSync` when a request resolved its auth, blocking the event loop until the command ended. They now run with `spawn`, with the same shell, 10 s timeout, caching and error messages. Adds async forms of the config value resolvers; `ModelRuntime.getCompatibilityRequestConfig()` (internal) returns a promise.

- Upstream: [earendil-works/pi#11186](https://github.com/earendil-works/pi/issues/11186), branch `fix/async-config-commands`.

## 004 tool-fs-operations

`read`, `edit` and `write` called `node:fs` on files they had custom `operations` for: `access` while resolving the path to read, and `realpath` for the file mutation queue key. Under Electron that opened `.asar` files and kept them locked. Adds optional `ReadOperations.exists`, `EditOperations.realpath` and `WriteOperations.realpath`, and a `realpath` argument to `withFileMutationQueue()`; custom operations without them use their own `access` and the absolute path.

- Upstream: [earendil-works/pi#11235](https://github.com/earendil-works/pi/issues/11235), branch `fix/tool-fs-operations`.

## 005 open-async

Adds `SessionManager.openAsync(path, sessionDir?, cwdOverride?, { signal })`, which reads a session file in 1 MB chunks without blocking the event loop; `AgentSessionRuntime` uses it to switch to, fork and import a session. The session reader also takes linear time on a line that spans many chunks, for `open()` too (one 100 MB line: about 2.4 s before, 0.3 s after). The newline that completes a torn last line goes only to the file that was read: the repair opens the path without creating it and writes only if it has the device and inode of the still-open read handle, so a session file deleted or replaced during the read is never recreated or written, by `open()` either. It also adds `createBranchedSessionAsync(leafId, { signal })`, which writes a fork's file in 1 MB chunks with the same bytes and resulting state as `createBranchedSession`, switches the manager only once the file is complete, and leaves no file and the manager unchanged on an abort, a failure or a path deleted meanwhile; `AgentSessionRuntime.fork` uses it. `openAsync` refuses a file that does not parse as a session itself, after an async `stat`, so the constructor never reads the file synchronously.

- Upstream: [earendil-works/pi#11187](https://github.com/earendil-works/pi/issues/11187), branch `fix/open-async` (the two commits of `AizenvoltPrime/pi` `open-async-session`, then the repair fix, the async branch write and the refusal of a file that is not a session).

## 006 edit-result-export

pi's edit computed its whole result and its diff in one `execute`, so a host that runs the edit itself could reach pi's matching (its fuzzy match, BOM and line-ending rules and refusals) only by running the whole edit, diff included. The diff has no bound: a single edit that rewrites 3,000 lines took 4.3 s of jsdiff on the calling thread, 5,000 lines 12.8 s, where the text computation took 2 ms. Adds `computeEditResult(rawContent, edits, path)`, exported from the package, which returns `{ finalContent, baseContent, newContent, replacements }` and throws the edit's refusals; the edit's `execute` calls it, then diffs and writes as before. Damocles runs every single-replacement Edit through it (`replace_all` uses Damocles' own exact match) and computes the patch on its diff worker, and its approval preview calls it and runs no diff.

- Upstream: not filed yet, branch `fix/edit-result-export` (`AizenvoltPrime/pi`).
- Damocles' test: `src/core/pi-session/tools/__tests__/edit-tool.test.ts`, "leaves the bytes pi's edit leaves and answers as it does, for %s" (a single replacement) and "keeps the event loop responsive while it patches a single replacement that rewrites 5,000 lines"; `src/core/permission-handler/__tests__/proposal-diff-view.test.ts`, "refuses an old_string %s with pi's own message".
