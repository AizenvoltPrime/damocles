# Performance baseline

Damocles logs coarse `[perf]` timing lines to the Damocles output channel, always on. Webview lines arrive through the existing `log` message and appear as `[Webview] [perf] ...`; they are also mirrored to the webview devtools console.

Line format: `[perf] <label> <ms>ms k=v ...`, with ms at one decimal. No line is per file or per message; counts are fields.

## Spans

| Label | Measures | Fields |
|---|---|---|
| `activate` | `activate()` start to end | |
| `activate.provider` | `new ChatPanelProvider` | |
| `compass.startFor` | startup Compass start (single-folder window) | `enabled` |
| `panel.html→ready` | webview HTML set to its `ready` message | |
| `ready.sessions`, `ready.settings`, `ready.promptHistory`, `ready.folderOf`, `ready.replay` | steps of the `ready` handler | `failed` on error, except `ready.settings` |
| `ready.total` | the `ready` handler up to posting the prompt history; the session start and model request, which begin once the session list is posted, are not included | `path=restore\|fresh\|switch` |
| `sessions.list` | `listPiSessions` up to the index worker's first answer, one line per folder | `files`, `hits` (rows still valid, answered at once), `misses` (files the worker parses after answering) |
| `sessions.listParsed` | `listPiSessions` up to the worker's last parsed batch, one line per folder; the worker sends a batch every 250 ms while a parse runs, so `batches` counts empty ones too, and the panels get one first page per 250 ms of batches | `rows` (parsed rows delivered), `batches`, `complete` (false when the list ended early or a file yielded no row) |
| `sessions.upsert` | list upsert, only above 20 ms; a watcher event whose file matches the cache logs none | `source=live\|file`, `applied` |
| `promptHistory` | `extractPiPromptHistory` | `files` (parsed by the index worker), `prompts` |
| `pi.import` | dynamic import of pi | |
| `replay.resolve`, `replay.open`, `replay.reconstruct`, `replay.usage`, `replay.hydrate`, `replay.post`, `replay.total` | `loadPiSessionHistory` | `entries`, `items`, `agents`; `approxChars` only with `damocles.debug` on |
| `runtime.init`, `folderRuntime.create` | pi runtime and per-folder runtime creation | |
| `memory.open` | memory database open, pragmas and migrations on the calling thread; the integrity check and any salvage, both on the worker, are not included | `failed` |
| `memory.integrity` | one request of the memory integrity worker, logged by the worker; memory writes wait for a `check` at most 5 s (`MEMORY_WRITE_HOLD_MS`) | `op=check\|rebuildFts\|repair`, `result` (a verdict or a repair outcome) |
| `start.syncProviders`, `start.createRuntime`, `start.total` | `PiSession.start()` | `timedOut`, `resumed` |
| `boot.readySent` | webview, from navigation start | |
| `boot.resources` | webview, ms is when the last boot chunk finished | `index.js`, `vendor.js`, `shiki-core.js` as duration/decoded size (0KB means the size was not exposed) |
| `replay.ingest` | webview, `sessionCleared` to the replay's `done`; a failed load logs none | `items` (`errorReplay` not counted) |
| `replay.painted` | webview, `sessionCleared` to after the next frame's layout and paint following the replay's `done` | `items` |
| `shiki.firstHighlight` | webview, first `getHighlighter` call to ready | `lang`, `theme`, `init` (ms to create the highlighter), the grammar and theme chunks as fetch duration/decoded size; `failed` on error |

`approxChars` is the summed string length (UTF-16 code units) of the replay items, not a serialized size. Runs 1 to 7 took `replay.painted` in the frame callback, before layout and paint, logged the field as `approxBytes`, and timed the fresh panel's start inside `ready` as `ready.initializeEarly`.

## Stalls (desktop)

The desktop app runs two processes with their own stall monitor (`src/desktop/local-services/stall-monitor.ts`), and each writes its own files:

| Process | Log | Stall profiles | `[stall]` line |
| --- | --- | --- | --- |
| Desktop main: windows, views, menus, dialogs, terminals, Quick Open, the updater | `<userData>/logs/Damocles.log` | `<userData>/logs/stalls/` | `the main process was blocked` |
| Damocles Core (utility process): pi, MCP, memory, sessions, source control, worktrees and their process starts | `<userData>/logs/Damocles_Core.log` | `<userData>/logs/stalls/core/` | `the core process was blocked` |

A main stall freezes every window. A core stall delays the agent, source control and chat updates while the window stays responsive. Read both logs for a session: main's `[core]` lines record core's start, ready (or a missed ready deadline), shutdown, exits and restarts with its pid, and core's log holds the engine's own lines (`[git]`, `[network]`, `[ShellSentinel]`, `Damocles core disposed`). `app.getAppMetrics()` lists core with the name `Damocles Core`; the OS process list shows it as a utility process of the app binary (`--utility-sub-type=node.mojom.NodeService`) whose pid main logs.

Each monitor keeps V8's sampling profiler running on its process's main thread, in release builds too. When its 100 ms heartbeat lands 1 s or more late, it logs a `[stall]` entry to its process's log: the blocked time, how much of it the profiler sampled busy and idle, the main thread's CPU time over the stall (`process.threadCpuUsage()`, which leaves out other threads and workers), the four heaviest call stacks with their ms, and a `.cpuprofile` of the stalled stretch in its stall folder, which keeps the newest 20. Open a profile in Chrome DevTools' Performance panel.

The profile rolls over to a new 10 s segment on a heartbeat. A roll-over cannot run during a stall, so the segment running when a stall began covers all of it. Stopping a segment holds the thread for time that grows with the segment; a stop over 50 ms logs `[stall-monitor] segment stop took N ms`. The next segment starts before the running one stops, so V8 keeps one profiler across the roll-over (0.1 ms). The inspector's `Profiler.stop` then `Profiler.start` builds a new one, which walks the heap: 220 to 270 ms per roll-over on a 323 MB heap.

V8's profile serializer, which `v8.startCpuProfile()` uses, writes `functionName`, `url` and `deoptReason` unescaped (nodejs/node#67097), so a Windows path or a quote in a frame name makes its text invalid JSON. `readCpuProfile` re-escapes those three fields, each ending where the serializer's fixed key order resumes, and the saved `.cpuprofile` is that escaped JSON.

A stall sampled busy for under 100 ms keeps no profile and logs one of two readings:

- **The process was not scheduled**: the main thread ran on a CPU for under 10% of the blocked time. The OS did not run it: system load, a sleep the power monitor missed, or OS throttling.
- **Native work on the UI thread**: the main thread kept a CPU busy, but the profiler took no JavaScript samples, as in native code Electron or Chromium runs on that thread.

On macOS neither monitor runs a profiler (`processProfiler`) and logs only the blocked time and the main thread's CPU time. With V8 sampling main, two launches on the release workflow's macOS arm64 runners hung at the startup `git --version` spawn: the probe's own timeout never fired, and `app.close()` could not quit the app. No Windows or Linux launch hung.

### Tools

Each script in `scripts/perf/` starts with its usage.

- `node scripts/perf/stall-report.ts <logsDir>` groups the `[stall]` entries of `Damocles.log` and `Damocles_Core.log` (and their rotated copies) by cause (the heaviest stack's Node API frame and its nearest named callers) and prints counts, total, median, p90 and max, plus the count of slow segment stops, one block per process (`main process`, `core process`, named by the file). Pass a profile from `logs/stalls/core/` to `cpuprofile-runs.ts` for a core stall.
- `node scripts/perf/cpuprofile-runs.ts <file.cpuprofile> [function]` lists the contiguous sample runs under a function (default `spawn`) with their calling stacks, which tells one slow call apart from many fast ones.
- `node scripts/perf/profile-desktop-main.ts --seconds <n> [--from <userData>] [--project <folder>] [--sessions <n>] [--out <dir>] [--interval-us <n>]` profiles the dev build's main process, not Damocles Core, from its first instruction, sampling every `--interval-us` microseconds (default 1000). Run `npm run build:desktop` first, and on Windows `node scripts/brand-dev-electron.ts`, which writes the Electron copy the dev build runs on (`npm run dev:desktop` runs both). It runs a fresh temporary `--user-data-dir`, copies `projects.json`, `trusted-folders.json` and `window-layout.json` from `--from`, and restores the project's `--sessions` most recently modified sessions. The packaged app cannot be profiled this way: its `enableNodeCliInspectArguments` fuse is off.

### First launch of a new Electron binary (Windows)

A `[stall]` whose heaviest stack is `startThread < Worker node:internal/worker` (core spent its time inside `new Worker()`, with little main-thread CPU) on the first launch of a binary file is the operating environment, not Damocles. Measured 2026-10-21 on the i7-13650HX, Windows 11 Pro 10.0.26200, Electron 44.7.0, with Kaspersky 21.26 real-time protection on and the Microsoft Defender service not running; dev launches ran the dev build on a copy of `dist-damocles-dev`, packaged ones on a copy of the installed 3.7.0.

- **Cold launches** (the first launch of an Electron binary file this machine had not run, either a byte-identical copy at a new path or a copy with bytes appended): all 14 dev launches lost 2.2 to 3.6 s in one window within the first 5 s. In 11 it landed on core's main thread in a worker start (`[stall]` 2,188 to 2,863 ms); in the others it landed on the chats' pages (`panel.html→ready` 3.0 to 4.1 s, against 0.25 to 0.9 s) and on git calls started in it (2.9 to 3.5 s, against 0.05 to 0.65 s on the warm relaunch). Packaged copies with a new `Damocles.exe`: 2 of 3 first launches lost the same window, once in a worker start (2,505 ms, same stack) and once between main forking core and core's first log line (2.9 s, against 0.5 s).
- **Warm launches** had none: 5 relaunches of cold copies, and 22 launches on the usual `dist-damocles-dev`, 3 of them the first after `npm run build:desktop` (twice after `npm run build` too) and 12 on a freshly written copy of every `dist` file. Core's worker starts took 0.6 to 17 ms.
- **What the thread waited on**: core's main thread was in a kernel wait (thread state Waiting, wait reason Executive; user-mode waits report UserRequest or WrAlertByThreadId) while the thread it was creating already existed in state Initialized. In the same window an unrelated `node.exe` took 2,884 and 3,036 ms to start a worker (16 ms at most in the warm control run), a process list query (`NtQuerySystemInformation`) and a minidump of core returned only when core's worker start did, and `avp.exe` used about one core: 6.6 s of CPU over the 7 s around a cold launch's start, against 1.9 s around the warm relaunch's and 0.5 s per idle 10 s. Thread starts stalled outside Damocles too.
- **Ruled out**: the loader lock (a worker holding it with `LdrLockLoaderLock` did not delay `new Worker()` on the parent, 0.7 to 5.4 ms, the new thread waited instead), native addons (core's main thread loads none at startup, `koffi.node` loads on launcher workers in 0.5 to 2.2 ms, and freshly written 25 MB and 3 MB DLLs loaded in 54 to 90 ms beside worker starts of at most 2.6 ms), and the build (it writes no `.node` or `.dll`; `brand-dev-electron.ts` rewrites `dist-damocles-dev` only when its stamp changes).
- **Not established**: whether Kaspersky causes the window (it was not turned off), and which step of the app's start opens it: never-seen copies run as Node (`ELECTRON_RUN_AS_NODE`) opened none, as 637 worker starts over 15 s each took under 50 ms, and 4 child processes of the same binary delayed an unrelated process's worker start by 228 ms at most. The 5,506 ms smoke stall that prompted this ran on a `dist-damocles-dev` unchanged since 2026-10-15, as the first dev launch after a reboot 22 minutes earlier; launches after a reboot were not measured.

Users see it once per binary file: the first launch after an install or update, when a thread or process start lands in the window (a delayed first chat, a slow first page, slow first git calls). Core cannot step around it: its worker starts, its git starts and the chats' page loads all waited in the window, and so did a worker start in an unrelated process.

### Synchronous calls (lint)

`damocles/no-sync`, a local rule in `eslint.config.mjs`, fails `npm run lint` on a call to any `*Sync` function or method (`readFileSync`, `existsSync`, `execFileSync`, `spawnSync`, ...) in the trees `NO_SYNC_FILES` lists (`src/core`, `src/desktop/main`, `src/desktop/core-host`, `src/desktop/core-protocol`, `src/desktop/local-services`, `src/desktop/workspace`, `src/desktop/daemon`, `src/remote`, `src/platform`, `src/shared` and `src/vscode`), the code that runs on the desktop UI thread, Damocles Core's thread, the VS Code extension host's thread or the remote daemon's main thread, which relays every client's traffic. A `this._with…Sync(op)` call, which chains `op` on one of `PiRuntime`'s async queues, is not flagged. Tests (`__tests__` folders and `*.test.ts` files wherever they sit), benches and `WORKER_ONLY_FILES` (files only worker threads load, listed one by one) are exempt; `scripts/__tests__/no-sync-lint-scope.test.ts` fails when a host bundle includes a listed file. It is local because `eslint-plugin-n`'s `n/no-sync` throws on TypeScript files without typed linting.

- **Burn-down list.** `eslint-suppressions.json` holds the calls that predate the rule. ESLint fails on a suppression no longer used, so a change that removes a synchronous call also runs `npx eslint "src/**/*.{ts,vue}" --prune-suppressions`. Suppressions count per file per rule, so swapping one synchronous call for another in the same file passes.
- **Permanent exceptions** carry `// eslint-disable-next-line damocles/no-sync -- <reason>`: the session lease's `lockSync` and `clearEndedHoldersLock`'s `statSync`, `renameSync` and `rmSync` (a claim never waits), `readLiveSessionMetadata`'s `statSync` (stat and snapshot run back to back), the voice sidecar's `killChildSync` (VS Code's deactivate does not await), the desktop log sink's folder creation and write at exit or dispose, and in `daemon/process-starts.ts` the bridge's read of its own descriptors right before its one daemon start and the daemon's `closeSync` of the inherited ones before it serves anything.
- **Not caught:** `node:sqlite` calls, which are synchronous by design, and synchronous work inside an async API: npm `tar` inflates each 16 MB read with `minizlib` on the calling thread, so the voice installer unpacks the Python archive on a worker (`voice/runtime/extract-worker.ts`, `dist/voice-extract-worker.js`), which a failed or cancelled extraction ends before removing the partial `python/` folder. pip's output is kept as a 64 KiB tail per stream.
- **Session opens** have a rule of their own: `damocles/session-open-async` fails a call to pi's `SessionManager.open`, which reads and parses a whole session file on the calling thread, and to `createBranchedSession`, which writes a whole branch there, in the same trees except tests, `WORKER_ONLY_FILES` and `meta-index/parser.ts`, the session index's parse thread (`scripts/__tests__/session-open-lint.test.ts`); engine code opens with `openAsync` and branches with `createBranchedSessionAsync` (`docs/invariants.md`, "Only the metadata index's parse thread opens a session file synchronously").
- **Process starts** have a rule of their own: `child_process`, `node:child_process` and `cross-spawn` may be imported only by tests and the files `PROCESS_STARTERS_CORE` and `PROCESS_STARTERS_DESKTOP` in `eslint.config.mjs` list (`scripts/__tests__/child-process-lint-scope.test.ts` probes each top-level folder of every tree under `src` but the two utility process hosts, renderers and workers included); everything else starts through the process launcher, whose workers keep the synchronous `CreateProcessW` off these threads.

## Diff worker

jsdiff's diffs run on the diff worker (`src/core/diff`, `dist/diff-worker.js`); linear passes may run on a host thread. jsdiff's line diff (Myers) costs file length times changed lines, so it runs on the worker. Reading a file, normalizing its line endings, hashing it, cloning it to the worker and applying recorded patches (`applyRecords`, `undoRecords`) are linear and stay on core's thread, as VS Code applies edits on its main thread and sends only diff computation to its editor worker.

- **Lanes.** A lane is one queue served by one worker thread, one job at a time; core keeps the queue, so a crash or a watchdog stop is blamed on exactly the running job and the jobs behind it run on a fresh worker. The review lane runs the chat review's line diffs (`lineDiff`: one jsdiff `structuredPatch`, whose hunks give the added and removed counts) with a 3 s budget (`REVIEW_DIFF_TIMEOUT_MS`, VS Code's chat-edit value) and the 20,000-edit bound. A job past either bound answers too large, and the review lists the file with no counts, as VS Code's chat edits show no counts for a diff that quit early. The tool lane runs the Write tool's and `replace_all`'s patches and their approval cards' (`filePatch` in `src/core/diff/jobs.ts`) with a 1 s budget (`FILE_PATCH_TIMEOUT_MS`, VS Code's and Damocles' quick-diff value) and the 1,000-changed-line bound; past either the patch is omitted as too large, which the cards already render. The agent's turn waits on a tool patch, and a running job cannot be preempted, so tool patches have their own lane and never wait behind a review diff of up to 3 s (Chromium's threading guide, `docs/threading_and_tasks.md` in its source, keeps user-blocking work off sequences that run long background tasks). The edit bound keeps most patches cheap: the costliest measured is a 10 MB file of 2,000-character lines with 455 changed lines, about 340 ms of jsdiff that ran on core's thread before (`write-tool.test.ts`). A single Edit's patch runs on the tool lane too (`editPatch`): core cuts the windows of whole lines around its replacements (`editDiffWindows`, linear) and sends only those, and the worker diffs them as pi's edit does, with the 1 s budget for all windows together and no edit bound, since pi's patch has none. A 5,000-line rewrite in one Edit cost about 13 s of jsdiff on core's thread inside pi's edit; on the tool lane the patch is omitted after its budget, and the event loop's longest delay was 20 to 21 ms (`edit-tool.test.ts`). The Edit approval preview runs no diff (pi's `computeEditResult`, patches/README.md 006), and a single Edit's approval card gets its patch from `editPatch`, as its result does.
- **Lifecycle.** A lane's worker starts on its first job and stops after 5 idle minutes, as VS Code's editor worker does. jsdiff checks its deadline once per edit step, so a watchdog stops a worker that has not answered 2 s after the job's budget (`DIFF_WATCHDOG_GRACE_MS`); that job answers too large, as does one whose worker crashed or ran out of memory, a queued job whose signal aborted, and every job of a closed service. A job that throws is a bug, and its call rejects; each caller treats the rejection as no diff for that one item. A worker whose job ran to its budget is replaced before the next job: after the incident's diff on the same worker a 2,000-line rewrite of a 20,000-line file took 2.8 to 3.0 s, on a fresh worker 1.7 to 1.9 s.
- **Start failures.** A worker that exits before it posts `ready` failed to start (a missing or broken bundle), and so did one whose constructor threw, which also answers the job at the head of its queue too large. Three in a row switch the service off for the process with one log line, and every job then answers too large; it never falls back to diffing on the host thread. Tests tie each host's worker names to the bundles its build writes: `src/vscode/platform/__tests__/app-paths.test.ts` to `EXTENSION_BUNDLES`, whose outfiles `scripts/__tests__/sync-vscodeignore.test.ts` checks are the files the VSIX allowlist ships; `src/desktop/main/__tests__/app-paths.test.ts` to `DESKTOP_BUNDLES` and `ASAR_UNPACK`; and `src/desktop/daemon/__tests__/remote-core-host.test.ts` the daemon's `WORKER_BUNDLES` to `SERVER_BUNDLES`. Only the desktop package check (`scripts/verify-desktop-package.ts`) looks for the worker in a built package, each worker `ASAR_UNPACK` lists; the VSIX and server package checks do not.
- **Heap.** Each lane worker's old generation is capped at 512 MB (`DIFF_WORKER_HEAP_MB`), so a diff never grows core's own heap, and each lane's worker adds at most 512 MB of old generation to the process. Measured on Node 24.21 (i7-13650HX): the incident's diff peaks at 57 MB of heap when run to the 20,000-edit bound, and runs to its 3 s budget within 24 MB of old generation, a 10 MiB pair of 500,000 lines with 1,000 changes needs 96 to 128 MB, and a 10 MiB pair of two-byte lines (5 million lines) 256 to 512 MB. 10 MiB is the review's size bound (`EDITOR_CONFIRM_DOCUMENT_BYTES`), so every file the review diffs fits.
- **Lint.** In `NO_SYNC_FILES` outside tests, `damocles/host-diff` allows only jsdiff's linear value exports (`JSDIFF_LINEAR_EXPORTS`: `applyPatch`, `applyPatches`, `parsePatch`, `reversePatch`, `formatPatch`, the three header constants, `canonicalize` and the two change converters) and type imports. It fails an import or re-export of any other name (the diff functions such as `diffLines` and `structuredPatch`, and their diff objects such as `lineDiff`), a default import in either form, a namespace import, `export *` with or without a name, `import … = require('diff')`, a dynamic import and a `require` of `diff`. Only the files `HOST_DIFF_ALLOWED` lists may diff: `src/core/diff/jobs.ts`, which holds the tool lane's `filePatch` and `windowedEditPatch` and which `WORKER_ONLY_FILES` keeps out of every host bundle (`scripts/__tests__/no-sync-lint-scope.test.ts`), and main's `damocles diff` (`desktop/main/cli-requests.ts`), which uses jsdiff's yielding callback form with a 5 s timeout. `scripts/__tests__/host-diff-lint-scope.test.ts` probes each top-level folder of every tree, and fails when a jsdiff upgrade adds an export the test has not classified as linear or a diff.
- **The incident.** On 2026-11-18 a worktree chat had rewritten `src/remote/protocol-snapshot.json` from 57,616 to 89,011 lines, a 102,397-line diff. Each chat review recompute ran `diffLines` on core's thread until the 20,000-edit bound, 50 to 80 s, and `Damocles_Core.log` held a `[stall]` line about every 90 s for two hours, each 41 to 126 s. `src/core/pi-session/__tests__/chat-review-worker.test.ts` repeats it: on the thread the review blocked the event loop for 68,283 ms of a 70,193 ms compute; on the worker the loop's longest delay was 19 to 26 ms and the compute took 3.1 s, the big file listing as too large and a 300-line rewrite of a 20,000-line file beside it with its exact counts.

## Manual procedure

1. Run `npm run build`, then launch with F5 or install the VSIX. Record the machine, VS Code version, session file count and total MB, and the test conversation's size.
2. Cold start. Use the workspace with about 900 sessions and a panel restored on a large conversation. Close all windows, reopen, and copy the `[perf]` lines from Output > Damocles. Also note the activation time from "Developer: Show Running Extensions". Do 3 runs and take the median.
3. Warm reload: run "Developer: Reload Window" 3 times.
4. Switch between two large conversations, A to B to A, 3 times.
5. After the restore, record the `start.*` spans that follow `ready.total path=restore`; time the first prompt separately.
6. Open a fresh panel and record the `ready.*` spans.
7. Run a 10-tool-call turn in a large conversation and record the `sessions.upsert` lines.

## Manual baseline

Run 1, 2026-09-26: F5 Extension Development Host (debugger attached), i7-13650HX, workspace `c:\GameDev\iemis` with 350 session files (68 MB, all header version 3). Cold window start with a fresh panel, then four switches between small conversations (3 to 6 replay items). Not yet measured: a panel restored on a large conversation, warm reload, the first prompt after a restore, and a 10-tool-call turn.

| Span | Value |
|---|---|
| `activate` | 9.6 ms |
| `panel.html→ready` | 1,374 ms |
| `pi.import` | 1,345 ms |
| `boot.readySent` | 1,157 ms |
| `boot.resources` | 1,028 ms; index.js 32 ms/927 KB, vendor.js 24 ms/554 KB, shiki-core.js 16 ms/753 KB |
| `sessions.list` cold | 6,436 ms, files=350 misses=350 |
| `ready.sessions` | 7,784 ms |
| `ready.promptHistory` | 511 ms (`promptHistory` opened 350 files for 402 prompts) |
| `ready.initializeEarly` | 1,459 ms |
| `ready.total` (fresh) | 9,757 ms |
| `runtime.init`, `folderRuntime.create` | 617 ms, 1,133 ms |
| `start.syncProviders`, `start.createRuntime`, `start.total` | 76 ms, 5 ms, 1,958 ms |
| Watcher storm after the cold list | about 300 `sessions.upsert source=watcher` lines, each running its own `sessions.list` (hits=350) of 6.3 to 9.8 s, overlapping, ending 14 s after the panel's HTML was set |
| `shiki.firstHighlight` | 8,441 ms, lang=txt |
| Switch: `replay.resolve` / `replay.total` | 51 to 63 ms / 53 to 66 ms |
| Switch: `switch.rewindIds` | 18 to 30 ms (span removed: the switch now reuses the rewind ids the replay read) |
| Switch: `sessions.upsert source=live` | 26 to 39 ms |
| Switch: `replay.ingest` / `replay.painted` | 50 to 65 ms / 55 to 70 ms |

The watcher storm: reading a session file updates its NTFS last-access time (this machine reports `DisableLastAccess = 2`, updates enabled, at most once an hour per file), and `fs.watch` on Windows reports that as a change. The cold list reads every file, so it fires one change event per file not read in the last hour. Each event's upsert found `allSessionsCache` empty, because the first load had not finished, and started another full load.

### Run 2, after the list, cache and replay changes

Same machine and workspace, F5, two cold window starts with a fresh panel (no restored conversation): the first with no disk cache, the second with it.

| Span | Baseline | First start | Second start |
|---|---|---|---|
| `sessions.list` | 6,436 ms, misses=350 | 6,688 ms, misses=350 | 2,449 ms, misses=0 |
| Watcher upserts after the list | about 300, 6.3 to 9.8 s each | none | none |
| `promptHistory` | 511 ms, 350 files | 79 ms, 0 files | 134 ms, 0 files |
| `ready.settings` | 2 ms | 639 ms | 894 ms |
| `ready.total` (fresh) | 9,757 ms | 7,833 ms | 3,907 ms |
| `start.total` | 1,958 ms | 3,138 ms | 2,765 ms |

`ready.settings` now runs first and absorbs the pi import the list used to pay. The second start's 2.4 s list, with every entry cached, ran alongside the pi start: it awaited one `stat` per file, each queued behind pi's synchronous work. `listPiSessions` now stats all files at once and loads pi only on a miss. The second start's `panel.html→ready` of 9,720 ms came from the webview fetching `index.js` (9,335 ms, against 27 ms in the first start), before any Damocles code ran.

### Run 3, restore and switch

A panel restored on a copied 10.4 MB conversation (1,083 entries, 54 replay items, 6 subagent cards), then a switch to a 28 MB one (1,717 entries, 238 items) and back.

| Span | Restore A | Switch to B | Switch back to A |
|---|---|---|---|
| `replay.resolve` | 55 ms | 178 ms | 86 ms |
| `replay.open` | 58 ms | 82 ms | 27 ms |
| `replay.hydrate` | 1,968 ms, agents=6 | 1 ms | 61 ms, agents=6 |
| `replay.post` | 104 ms, approxBytes=7,233,559 | 33 ms, approxBytes=1,671,931 | 82 ms |
| `replay.total` | 2,190 ms | 299 ms | 260 ms |
| `replay.painted` (webview) | 2,485 ms | 392 ms | 291 ms |
| `shiki.firstHighlight` | | 120 ms, python | |

Other restore spans: `ready.total` 4,161 ms (path=restore), `sessions.list` 802 ms (hits=352), `promptHistory` 1,104 ms (files=0), `start.total` 2,074 ms.

The pi session started when `ready` arrived, not after the replay: the `ready` handler's `sendAvailableModels` calls `getSupportedModels`, which runs `ensureStarted`. So a restored panel never deferred its start, and the start ran alongside the restore, which is why the restore's `replay.hydrate`, `sessions.list` and `promptHistory` were slow and the same conversation's hydrate took 61 ms on the later switch. The model request now runs after the replay, the list and the prompt history, and `extractPiPromptHistory` stats its files in batches, stops at the prompt cap, and loads pi only on a miss. On a switch, the panel's running pi session also opens the target file itself, which is the likely cost in the switch's `replay.resolve`.

### Run 4, fresh panel after the model-request move

| Span | Value |
|---|---|
| `panel.html→ready` | 425 ms |
| `ready.settings` | 2.6 ms |
| `sessions.list` | 41 ms, files=350 misses=0 |
| `ready.sessions` | 42 ms (list posted 0.55 s after activation) |
| `pi.import`, `runtime.init`, `folderRuntime.create` | 1,114 ms, 1,500 ms, 1,187 ms |
| `ready.initializeEarly` / `start.total` | 3,063 ms / 3,041 ms (now includes the pi import the list used to pay) |
| `promptHistory` | 1,129 ms, files=0, while MCP servers and the memory index start |
| `ready.total` (fresh) | 4,241 ms |

### Run 5, restore after the model-request move

Conversation A (10.4 MB, 54 items, 6 subagent cards) restored in its panel, then switched to B (28 MB) and back.

| Span | Run 3 restore | Run 5 restore | Run 5 switch to B | Run 5 back to A |
|---|---|---|---|---|
| `ready.total` | 4,161 ms | 1,679 ms (path=restore) | | |
| `pi.import` (inside the replay) | 768 ms | 1,150 ms | | |
| `replay.hydrate` | 1,968 ms | 220 ms | 1 ms | 202 ms |
| `replay.total` | 2,190 ms | 1,534 ms | 273 ms | 503 ms |
| `replay.ingest` (webview) | 2,482 ms | 1,762 ms | 402 ms | 534 ms |
| `sessions.list` | 802 ms | 42 ms | | |
| `promptHistory` | 1,104 ms | 20 ms | | |
| `shiki.firstHighlight` | | | 159 ms | |

The pi session now starts after `ready.total`. Webview `[perf]` lines carry the host's receive time, so they arrive late while the host is busy; compare `replay.ingest` against `replay.total`, not the log timestamps. Most of the remaining restore time is the pi import, which the replay needs to parse the file.

### Runs 6 and 7, pi import started when the panel page is set (reverted)

Importing pi from `getHtmlContent`, before the webview booted, cut `ready.total` to 430 and 595 ms but made the restore slower overall. Started that early, `pi.import` took 2,819 and 3,257 ms (1,150 ms in run 5), and the webview reported `ready` about 1.7 s after the import finished in both runs, although it needs only about 0.75 s from navigation to `ready`. The import ran before the webview boot, not beside it. Activation to the end of `ready` was 5.19 and 5.82 s, against 4.37 s in run 5. The import stays where the replay first needs it.

### Run 8, first window after the cache schema bump

Restore of A after the metadata cache schema went to 2, so every entry missed once. `sessions.list` 11,116 ms (misses=351), which the watcher upsert of the restored conversation waited on (11,090 ms), so `ready.total` was 12,750 ms. Later windows read the rebuilt cache. `replay.total` 1,493 ms including `pi.import` 759 ms; `start.total` 2,408 ms, after `ready.total`. `shiki.firstHighlight` took 7,638 ms (lang=markdown, theme=solarized-dark; 18 to 159 ms in runs 5 and 6); the markdown chunk imports nothing, so the span now reports its chunk fetch times to tell a slow fetch from a slow highlighter start.

### Run 9, second window after the rebuild

Restore of B (28 MB, 238 items), then a switch to A. `sessions.list` 91 ms (hits=352), `promptHistory` 106 ms, `ready.total` 1,475 ms (path=restore), activation to the end of `ready` 4.2 s; `start.total` 1,886 ms after it. Switch to A: `replay.total` 509 ms, `replay.painted` 614 ms. `shiki.firstHighlight` 299 ms with `init=270` and `solarized-dark.js=262ms/7KB`, `python.js=26ms/68KB`: the highlighter's start is the theme chunk's fetch, so run 8's 7.6 s was VS Code serving the webview's files, as with run 2's 9.3 s `index.js`.

### Run 10, desktop startup (S10)

2026-10-20, i7-13650HX, Windows 11, dev build (`npm run build:desktop`) after slices S1 to S8, `profile-desktop-main.ts --seconds 40 --project C:\GameDev\damocles --sessions 2` (a project with 140 sessions and a worktree folder with 544), each launch with a fresh userData. The session index file was new in launch 1, so its 684 files all missed; launches 2 and 3 still parsed the misses launch 1's 40 s did not reach. Only launch 1 ran with a cold disk cache for the new bundles; none ran after a reboot, so none is a cold OS start.

| Span | Launch 1 | Launch 2 | Launch 3 |
|---|---|---|---|
| `pi.import` | 1,513 ms | 937 ms | 789 ms |
| `runtime.init` | 1,623 ms | 1,066 ms | 868 ms |
| `folderRuntime.create` | 280 ms | 332 ms | 270 ms |
| `start.total` (two chats) | 2,247 / 1,344 ms | 1,706 / 1,179 ms | 1,375 / 908 ms |
| `memory.open` (main) | 13.7 ms | 8.1 ms | 5.5 ms |
| `memory.integrity` (worker) | 235 ms | 213 ms | 197 ms |
| first `sessions.list` answer, 544-file folder | 1,374 ms (misses 544) | 107 ms (misses 112) | 89 ms (misses 71) |
| git starts (`Git.log`) | 57 | 72 | 52 |
| `[stall]` entries | 1 | 0 | 0 |

- **The one stall** was launch 1's `pi.import`: 1,493 ms blocked, its heaviest stacks ESM module resolution (`internalModuleStat`, 257 ms) and `compileSourceTextModule` (227 ms). This run predates Damocles Core, which has since moved pi's load, and every other engine span in this table, off the UI thread.
- **Skills load 4 times per launch** with two chats restored in one project, about 200 to 250 ms on main in all: each of the folder runtime's two resource loads (its creation, and the second chat's per-session reload that gives it its own extension runtime, `prepareSessionExtensions`) scans skills in pi's `reload()` and again in `extendResources` for the `.claude`/`.codex`/`.damocles` asset folders. Neither load is a duplicate, so none was removed.
- **Git starts** all run on the process launcher; no startup git start ran on main.
- **The session index worker queued lists:** while it parsed the 544-file folder's misses, lists of three empty folders answered after 1.1 s, behind the parse. Parses have since moved to the worker's parse thread, so the index answers while one runs ("Session store" in `docs/invariants.md`).

### Bundled pi (S10 spike): not adopted

A single ESM bundle of `pi-coding-agent`, `pi-ai`, `pi-mcp` and `pi-mcp/oauth` (2,170 inputs from 57 packages, 14.3 MB, built with esbuild in 0.6 s) was timed against the external packages under the packaged app's Electron (`Damocles.exe` with `ELECTRON_RUN_AS_NODE`): the external form imported from the packaged `app.asar`, the bundle from an asar holding only the bundle. 12 interleaved runs each, every run its own process, warm disk cache:

| Form | Median | Min | Max | Range | IQR |
|---|---|---|---|---|---|
| External packages | 537.0 ms | 515.1 | 711.5 | 196.4 | about 25 |
| Bundle | 344.1 ms | 317.3 | 355.0 | 37.7 | about 21 |

The adoption rule takes the run-to-run spread as the range: the bundle's 193 ms gain is under twice the external form's 196 ms range, which two slow runs (706 and 712 ms) set, so the speed condition fails. Cold launches were not measured: the disk cache cannot be emptied without a reboot. The bundle also does not run correctly as built, so the suites were not attempted:

- pi finds its own package folder by walking up from its module file (`config.js` `getPackageDir` → `findNodePackageDir(__dirname)`). From `dist/pi-bundle.mjs` it would find Damocles' `package.json`, so `VERSION`, the themes, the HTML export templates and the docs would resolve against Damocles. `PI_PACKAGE_DIR` overrides it, but only through `process.env`, which every launched process inherits.
- pi resolves files next to its modules at run time: the image-resize worker (`new URL('./image-resize-worker.js', import.meta.url)`), the codemode worker, quickjs's `quickjs.wasm` (`createRequire(import.meta.url).resolve`) and extensions through jiti. A bundle would need each module's `import.meta.url` rewritten to its original file, and CommonJS `__dirname` defined per module.

Revisit if a cold-start measurement shows a larger gain, with the per-module `import.meta.url` rewrite in place.

### No V8 compile cache

Node's compile cache (`module.enableCompileCache`) is off on purpose. The desktop build enforces `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` (`electron-builder.yml`), and the cache reads and writes a folder outside `app.asar`: Node 24 has no read-only mode, so the app would load V8 bytecode that integrity validation never checks, and anyone who can write the user profile could inject code through it.

### First provider call pauses Damocles Core (accepted)

The first call through a provider API Damocles Core has not used yet pauses its thread for about 1 s while pi loads that API's code. pi-ai loads each API module on first use through `lazyApi` (`dist/api/lazy.js`), whose `load` callback in each `dist/api/<api>.lazy.js` (for example `openai-completions.lazy.js`) runs the `import()`, and the module pulls in its provider SDK: the `openai` package alone is 393 modules. A stall profile shows it at the first DeepSeek call (`openai-completions`). A preload would run on the same thread, so it only moves the pause, and it could land while another chat streams. The two ways to make module loading itself cheaper were measured and rejected above: "Bundled pi (S10 spike): not adopted" and "No V8 compile cache".

## Benchmarks

Run from PowerShell; neither needs VS Code:

```
npx vitest bench --run src/core/pi-session/session-store/__tests__/session-store.bench.ts
npx vitest bench --run src/webview/stores/__tests__/replay-ingest.bench.ts
```

The session-store bench writes real pi JSONL into the hermetic test home: 300 sessions of 5 turns (about 60 KB each) and one 4.6 MB conversation of 400 turns with 20 subagent calls and a compaction at turn 200; 22.4 MB in total. It runs the session metadata worker's runtime on the bench's own thread, so a parse counts there as it would in the worker. The cold rows close the index and delete `~/.damocles/cache/session-meta/` before every iteration; `listPiSessions cold, first answer` stops at the list's first answer and `listPiSessions cold, complete` at its last parsed batch. `listPiSessions new window` closes the index and starts a new worker on the file the last one committed, as a reloaded or second window does. The replay bench feeds `userReplay`/`assistantReplay` items (two tool calls each, a subagent card every 25 turns) through the real history handlers into fresh Pinia stores, then flushes the streaming store's replay queue as the replay's `done` does.

Baseline, measured before any change recorded in runs 2 to 7. Intel Core i7-13650HX, 32 GB, Windows 11 Pro 10.0.26200, Node 24.15.0 under Vitest 4.1.1 (not the VS Code extension host).

| Benchmark | Mean ms | Min ms | Max ms | Samples |
|---|---|---|---|---|
| `listPiSessions` cold, 301 files | 269.0 | 259.3 | 284.8 | 5 |
| `listPiSessions` warm, 301 files | 20.7 | 19.2 | 22.3 | 20 |
| `extractPiPromptHistory` (500-prompt cap, reached after the large file and about 20 small ones) | 23.2 | 21.2 | 25.0 | 5 |
| `loadPiSessionHistory`, large conversation, 603 posts | 20.4 | 17.9 | 24.6 | 10 |
| Replay ingest, 250 items | 6.2 | 5.2 | 8.4 | 10 |
| Replay ingest, 500 items | 20.0 | 17.3 | 27.9 | 10 |
| Replay ingest, 1,000 items | 73.6 | 68.7 | 81.7 | 10 |

Replay ingest grows about 3.2x per doubling of items, so it is superlinear, consistent with the full array copy on every appended message.

After replay batching, same machine and toolchain. Replay items now wait in the streaming store's replay queue and land in one array assignment per animation frame, or earlier when a non-replay message arrives or the store writes `messages`.

| Benchmark | Mean ms | Min ms | Max ms | Samples |
|---|---|---|---|---|
| Replay ingest, 250 items, batched | 1.3 | 1.2 | 1.6 | 10 |
| Replay ingest, 500 items, batched | 2.1 | 1.4 | 7.0 | 10 |
| Replay ingest, 1,000 items, batched | 2.5 | 2.3 | 3.1 | 10 |

Three runs gave means of 1.3 to 1.7, 2.1 to 3.0 and 2.5 to 3.5 ms; the 500-item max is a single outlier. Growth is now about linear, about 1.5x per doubling. The bench flushes once at the end, which is the hidden-panel path. A visible panel flushes once per frame, so it copies the array once per frame, not once per item.

After the persistent metadata cache (list metadata and prompts cached per file, session id to file index), same machine and fixture, run with other VS Code windows busy, so absolute figures carry more noise than the baseline:

| Benchmark | Mean ms | Min ms | Max ms | Samples |
|---|---|---|---|---|
| `listPiSessions` cold, 301 files, no cache anywhere | 344.1 | 335.9 | 356.6 | 5 |
| `listPiSessions` warm, 301 files | 33.1 | 25.7 | 42.8 | 20 |
| `listPiSessions` new window (in-memory cleared, disk cache warm), 301 files, 0 opens | 30.3 | 24.2 | 43.3 | 20 |
| `extractPiPromptHistory` cold | 30.0 | 25.7 | 33.6 | 5 |
| `extractPiPromptHistory` warm, 0 opens | 3.6 | 3.0 | 4.1 | 5 |
| `resolvePiSessionFile`, indexed after a list (one stat, no readdir) | 0.18 | 0.12 | 0.40 | 20 |
| `loadPiSessionHistory`, large conversation, 603 posts | 21.9 | 17.7 | 30.3 | 10 |

The cold and warm list rows differ from the baseline by machine load, not by the cache: an interleaved A/B of the earlier `listPiSessions` against this one in one process measured warm 19.3 to 26.8 ms against 20.3 to 20.9 ms, and cold 278.7 to 284.0 ms against 266.8 to 288.4 ms. What the cache changes is the new-window row, which was a cold list before, and the prompt history, which opened every file it walked.

After the session metadata index (a SQLite index owned by a worker thread, `docs/invariants.md` "Session store"), same machine and fixture, Node 24.21.0 under Vitest 4.1.1. The rows include the request round trips through the in-process port; in the apps the parses run on the worker thread, and the host thread only posts the request and applies the answers.

| Benchmark | Mean ms | Min ms | Max ms | Samples |
|---|---|---|---|---|
| `listPiSessions` cold, first answer (index closed and deleted, a new worker, 301 misses) | 36.5 | 35.1 | 39.1 | 5 |
| `listPiSessions` cold, complete (every parsed batch delivered) | 530.6 | 500.1 | 572.6 | 5 |
| `listPiSessions` warm, 301 files | 13.9 | 12.9 | 14.9 | 20 |
| `listPiSessions` new window (a new worker on the committed index), 0 parses | 18.3 | 17.4 | 19.4 | 20 |
| `extractPiPromptHistory` cold | 78.4 | 74.7 | 85.2 | 5 |
| `extractPiPromptHistory` warm, 0 parses | 5.3 | 5.0 | 5.7 | 5 |
| `resolvePiSessionFile`, indexed after a list | 0.21 | 0.15 | 0.46 | 20 |
| `loadPiSessionHistory`, large conversation, 603 posts | 39.1 | 34.5 | 48.7 | 10 |

A cold list now shows its valid rows after the first answer and fills in as batches arrive. The complete cold list takes about twice the earlier single-thread parse (269 to 344 ms) because it adds the index writes, one transaction per batch of 16 files, and the per-message round trips; a separate timing of 300 small files measured 189 ms for the bare parses against 253 to 265 ms for the complete list.

### Quick Open listing: the walk process against ripgrep's walk

Quick Open lists a project through the walk process (`dist/walk-child.js`, `docs/invariants.md` "Quick Open"), not with `rg --files`. The measurement compares the two on one generated tree, and shows how much of the listing runs on the thread that asks for it, which is main for a local project.

The tree had 213,201 files in 2,401 folders: 200 packages of 10 folders with 100 `.ts` files each, a `.gitignore` per package ignoring `*.log`, an `x.log` per folder, a `.git` folder of 1,001 files and a `node_modules` folder of 10,000 files. A separate folder held 20,000 files in one listing. Every run used Quick Open's default excludes (`files.exclude` and `search.exclude`, as `!` overrides) and all ignore files. The "200k" rows exclude the 20,000-file folder and list 200,200 files. The "50k" rows also exclude 150 packages (`pkg1*`, `pkg0[5-9]*`) and list 50,050 files. The "one folder" rows exclude every package and list the 20,000 files of the single folder. Every walk listed as many files as rg did.

The harness was a script bundled with esbuild from the sources (koffi external) and run under Node 24.21.0, not inside Electron. Its thread played main's part: it installed the process launcher pool as main does (`lockThreadSpawns`, the built `dist/process-launcher-worker.js`), and it relayed every batch, or every chunk of rg's output, to a worker thread, as main relays them to the Quick Open worker. The variants:

- **rg**: `rg --files --hidden --no-config -g !<exclude>... -- <root>`, ripgrep 15.0.0, spawned on the harness thread. The app started rg on the process launcher, so the synchronous spawn in this row's longest task did not reach main.
- **Walk process**: `createQuickOpenListing` over `createWalkHost` and `startWalkChild` with the built `dist/walk-child.js`, as Damocles Core runs it (main forks it as a utility process; the two transports are compared below the second table); the process ran under the harness's own Node.
- **Walk worker (removed)**: the same listing over the worker-thread host the walk process replaced, built from its last sources over the same walk code.
- **Walk on the calling thread**: `walkFiles` on the harness thread, which is what main would pay without the walk process.
- **First query**: the built `dist/quick-open-worker.js` asks for the list, the harness relays the walk process's batches to it, and the time runs until the worker answers the query `file050`.
- **First query over rg**: the same, with rg's output relayed to the Quick Open worker in batches of 1,000 instead, which is what a first query cost when rg listed the files.

Each variant ran 5 times after a warm-up of each, so the file system cache was warm. The order alternated between runs. Each run was timed twice. The plain pass gave the wall time and the event-loop utilization of the harness thread (`performance.eventLoopUtilization`: its busy time and busy share). The probed pass kept a `setImmediate` chain going and recorded the longest gap between two turns, which is the longest task the listing ran on that thread. The figures are medians; the range is minimum to maximum. Measured 2026-11-18 under Node 24.21.0. Intel Core i7-13650HX (20 threads), 32 GB, Windows 11 Pro 10.0.26300, NTFS SSD.

| Tree | Variant | Files | Wall ms | Range ms | Thread busy ms | Busy share | Longest task ms (median, max) |
|---|---|---|---|---|---|---|---|
| 50k | rg | 50,050 | 93 | 78-97 | 30 | 32% | 10.1, 13.7 |
| 50k | Walk process | 50,050 | 96 | 93-101 | 30 | 31% | 0.9, 2.1 |
| 50k | Walk worker (removed) | 50,050 | 97 | 88-101 | 26 | 27% | 0.9, 1.0 |
| 50k | Walk on the calling thread | 50,050 | 82 | 71-85 | 71 | 87% | 2.8, 3.3 |
| 50k | First query | 50,050 | 187 | 171-200 | 29 | 15% | 0.9, 1.9 |
| 50k | First query over rg | 50,050 | 170 | 164-172 | 47 | 28% | 9.8, 22.0 |
| 200k | rg | 200,200 | 253 | 247-286 | 79 | 31% | 9.8, 15.0 |
| 200k | Walk process | 200,200 | 335 | 311-376 | 111 | 33% | 1.2, 2.6 |
| 200k | Walk worker (removed) | 200,200 | 307 | 297-437 | 96 | 31% | 1.0, 2.2 |
| 200k | Walk on the calling thread | 200,200 | 258 | 237-338 | 229 | 89% | 2.8, 3.8 |
| 200k | First query | 200,200 | 665 | 643-759 | 107 | 16% | 1.6, 2.1 |
| 200k | First query over rg | 200,200 | 590 | 573-673 | 141 | 24% | 11.0, 12.9 |
| One folder | rg | 20,000 | 122 | 95-251 | 18 | 15% | 12.5, 20.3 |
| One folder | Walk process | 20,000 | 50 | 38-62 | 12 | 23% | 0.2, 2.9 |
| One folder | Walk worker (removed) | 20,000 | 32 | 29-54 | 8 | 25% | 0.3, 0.7 |
| One folder | Walk on the calling thread | 20,000 | 33 | 24-61 | 26 | 77% | 2.3, 4.4 |
| One folder | First query | 20,000 | 60 | 52-84 | 9 | 15% | 13.2, 15.4 |
| One folder | First query over rg | 20,000 | 117 | 100-138 | 23 | 20% | 11.7, 13.8 |

A run of the same harness without the removed worker's rows, the same day, gave the same picture: on the 200k tree rg 251 ms, the walk process 326 ms (main busy 110 ms, longest task 1.3 and 2.1 ms), the walk on the calling thread 265 ms, a first query 687 ms and a first query over rg 593 ms.

Two walks at once: a 200k Quick Open listing and a Search walk of the same tree (command-line batches as Search runs them, its rg left out), each alone one after the other, then both started together, on one walk host and on two; each walk's own wall time, 5 rounds in alternating order after a warm-up, medians and ranges. In runs 1 and 2 a walk host ran one walk process, so "one process" is one host; runs 3 and 4 used the host as it is now, which starts a second process for the second walk.

| Run | Walks | Listing ms | Range ms | Search walk ms | Range ms |
|---|---|---|---|---|---|
| 1 | alone | 504 | 482-543 | 497 | 444-573 |
| 1 | at once, one process | 932 | 811-954 | 933 | 808-953 |
| 1 | at once, two processes | 571 | 534-627 | 555 | 541-649 |
| 2 | alone | 496 | 413-563 | 539 | 420-675 |
| 2 | at once, one process | 1,018 | 664-1,126 | 1,020 | 664-1,122 |
| 2 | at once, two processes | 508 | 486-580 | 512 | 502-577 |
| 3 | alone | 436 | 316-773 | 364 | 314-679 |
| 3 | at once, one host | 443 | 351-773 | 480 | 374-834 |
| 3 | at once, two hosts | 583 | 402-667 | 574 | 382-668 |
| 4 | alone | 556 | 334-653 | 578 | 319-625 |
| 4 | at once, one host | 398 | 349-712 | 411 | 368-740 |
| 4 | at once, two hosts | 520 | 408-633 | 505 | 385-624 |

The alone rows of this mode took longer than the table's walk process row (about 500 against 335 ms for the same listing), and their ranges are wide; this mode starts two walk processes, and the cause of the difference was not found.

Start and memory: from a fresh walk host's first walk to the first batch of the one-folder tree took 113 ms (105-157, 7 starts) with the process under Node and 104 ms (87-147) under Electron 45.2.1 as Node (the harness itself run with `ELECTRON_RUN_AS_NODE=1`), and to that walk's end 124 and 111 ms. After a 200k listing, the walk process under Electron held a 68.8 MB working set and 73.8 MB of private bytes (one reading). A walk host keeps each of the up to two processes it started until it has had no walk and no held read for `WALK_IDLE_MS` (60 s), so main's and Damocles Core's hosts on desktop, and a daemon's and its Core's on a target, may hold about four such processes, near 280 MB and more for main's utility processes (below), for a minute after each has run two walks at once, and none once their walks have been idle that long.

Main's walk processes are utility processes, and the other hosts' are started on the launcher ("Concurrent starts on Windows" says why). The two transports, measured 2026-11-19 in Electron 45.2.1's main on the machine above (`harness5.ts`, bundled with esbuild and run by the app's `electron.exe`, the launcher pool installed as main installs it): a host over each listed the trees above with the built `dist/walk-child.js` in Quick Open's mode, 15 rounds in alternating order after a warm-up, an idle second before each. Main CPU is `process.cpuUsage()` of the whole main process over the listing (every thread, so the launcher worker's relay counts for stdio and Chromium's IO thread for the port), median.

| Tree | Transport | Files | Wall ms | Range ms | Main CPU ms |
|---|---|---|---|---|---|
| 200k | Launcher, stdio lines | 200,200 | 318 | 289-363 | 94 |
| 200k | Utility process, parent port | 200,200 | 338 | 323-379 | 63 |
| One folder | Launcher, stdio lines | 20,000 | 32 | 25-54 | under 16 |
| One folder | Utility process, parent port | 20,000 | 30 | 25-46 | under 16 |

From a fresh host's first walk to the first batch of the one-folder tree took 90 ms (88-125, 7 starts) on the launcher and 105 ms (94-141) as a utility process. The port carries the same batches of up to `WALK_BATCH_FILES` files as structured clones, so no line is parsed as JSON in main, and the walk's own time is the same on both; three earlier runs of fewer rounds on a busier machine gave wider ranges with the same picture (200k medians 602 and 595 ms, 654 and 653 ms, 346 and 507 ms with ranges of 313-638 and 316-591 ms). After the runs the utility walk process held a 108.4 MB working set and 96.5 MB of private bytes (one reading; 87 to 148 MB over the four runs).

Findings:

- **Main's longest task does not grow with the tree.** In the "Walk process" rows its median stayed between 0.2 and 1.2 ms from 20,000 to 200,200 files, and its longest was 2.9 ms. The "First query" rows also relay the batches to the Quick Open worker; for the one folder their longest task was 13.2 ms (median), as over rg's output, against 1.6 ms for 200,200 files, and its cause was not found. Main's total work is reading the process's lines, parsing them and checking each path, about 0.55 µs per file (111 ms for 200,200 files, spread over batches of up to 1,000). On the calling thread, the walk would hold main for the whole listing (89% busy).
- **The walk process costs a little over the worker thread it replaced.** For 200,200 files it took 335 ms against the worker's 307 ms, and main's busy time was 111 against 96 ms: each line crosses the launcher worker that started the process and is parsed as JSON, where the worker's batches arrived as structured clones. For 50,050 files the two were even (96 and 97 ms); for the one folder the process took 50 ms against 32 ms, with ranges that overlap.
- **The walk takes about 1.3 times rg's time on a deep tree, and less on one large folder.** On the 200k tree the walk process took 0.34 s against rg's 0.25 s, and a first query took 0.67 s against 0.59 s over rg's output. The list is cached per project until a create or delete under it, so later queries do not pay for the walk again.
- **Two walks on one walk process each take about the sum of their times; on two processes, about their own.** One process interleaves its walks folder by folder on one thread: a listing and a Search walk started together took 932 and 933 ms (1,018 and 1,020 ms in the second run) against about 500 ms alone, and 571 and 555 ms (508 and 512 ms) on two processes. So the walk host starts a second process for a walk that finds every running one busy (`MAX_WALK_PROCESSES`), and with it the two walks took 443 and 480 ms (398 and 411 ms) against alone rows of 436 and 364 ms (556 and 578 ms). A third walk at once shares the process with the fewest walks.
- **A child process start slowed the starting process in an earlier measurement, and not in these runs.** The earlier table, measured with the same tree and method on the same machine, found that any child start, even a `rg --version` one second earlier, made later CPU work in the harness process take about twice as long (the 200k walk on the calling thread 549 ms, against 251 ms with no other variant run); its cause was not found. In these runs, which start rg and the walk process before any timed run, that row took 258 and 265 ms, and a rerun of the earlier harness the same day took 310 ms for it. Every row here ran after child starts, as the app's processes run after git and rg starts.
- **The walk's time is CPU on its thread, not disk waits.** Before this tuning, the same harness measured the 200k walk, then on a worker thread, at 1.13 s and the first query at 1.57 s. Its profile was 98% busy: each entry tested every ignore and exclude glob's regular expression (a `**/name` glob backtracks over every `/`), walked up its folder chain to find the rules that apply, and was handed over in an async generator step of its own. The walk now matches as globset does, by looking up the path, its basename or its extension for the globs that allow it (`rg-ignore.ts`); computes each folder's rule chain once (`walk.ts` `childFolder`); and hands over one batch per folder. The walk process checks its flush interval once per folder: checked per file, it sent a nearly empty batch each time the walk resumed after waiting for credit. Reading 4, 8, 16 or 32 folders ahead made no difference (227 to 253 ms for the walk alone), so `READ_AHEAD` stays 8.
- **Most of a first query is now the Quick Open worker's own indexing.** Fed rg's output, which arrives in 0.25 s, a first query on the 200k tree still took 0.59 s.

### Search: walked batches against ripgrep's walk

Search lists a project through the walk process and runs rg on the listed files in batches, up to `walkedRgRuns()` at once: half the logical CPUs, at least 1 and at most 4 (`runWalkedRg`, `docs/invariants.md` "Search" and "Tool overrides"). The first measurement ran one rg at a time, as Search did then, and compares it with rg searching over its own walk; "Runs at once" below measures the runs at once. Both ran on the "200k" tree of the Quick Open section with the same excludes: 200,200 files, of which one per package (`pkgNNN/dir5/file050.ts`, 200 files) holds the pattern and every other is empty. The query was a fixed string with `--crlf --ignore-case`, all ignore files on.

The harness was a script bundled with esbuild from the sources and run under Node 24.21.0, with the process launcher pool as main installs it and the walk process bundled from the current sources. The variants:

- **rg's own walk**: `rg --json --no-config --hidden -g !<exclude>... --crlf --ignore-case --fixed-strings -- needle <root>`, started on the launcher.
- **Walked, budget**: `runWalkedRg` over a walk host's walk with that command-line budget (`lineBudget`), as the Search runner runs it.
- **Search runner**: `createSearchRunner` itself, which uses `BATCH_COMMAND_LINE`.

Each variant ran 5 times after a warm-up of each, in alternating order, with an idle second before each run. First match is the time to the first match event; Total, to the search's end. The figures are medians; the range is minimum to maximum. Measured 2026-11-18. Windows: Intel Core i7-13650HX (20 threads), 32 GB, Windows 11 Pro 10.0.26300, NTFS SSD. Linux: the same machine, WSL 2 (Ubuntu 24.04, kernel 6.18.58.1), ext4, `ARG_MAX` 2 MiB.

| OS | Variant | rg runs | First match ms | Range ms | Total ms | Range ms |
|---|---|---|---|---|---|---|
| Windows | rg's own walk | 1 | 99 | 61-152 | 6,732 | 5,212-8,205 |
| Windows | Walked, 16,000 | 292 | 135 | 125-150 | 39,330 | 36,699-41,008 |
| Windows | Walked, 32,000 | 145 | 278 | 270-303 | 41,848 | 40,717-42,695 |
| Windows | Search runner (32,000) | not counted | 282 | 278-295 | 41,255 | 40,871-42,113 |
| Linux | rg's own walk | 1 | 8 | 6-11 | 136 | 133-150 |
| Linux | Walked, 32,000 | 196 | 10 | 10-11 | 1,555 | 1,528-1,602 |
| Linux | Walked, 65,536 | 96 | 14 | 12-15 | 998 | 950-1,045 |
| Linux | Walked, 98,304 | 64 | 15 | 15-19 | 815 | 770-911 |
| Linux | Walked, 131,072 | 48 | 19 | 16-20 | 731 | 669-828 |
| Linux | Search runner (98,304) | not counted | 16 | 15-19 | 810 | 777-882 |

Every variant found the same 200 matches.

Findings:

- **With one rg at a time, Search over the walk took about six times rg's own walk on Windows and on Linux.** On Windows 41 s against 6.7 s, on Linux 0.81 s against 0.14 s. The walk itself takes about 0.3 to 0.5 s of that on Windows (the Quick Open section).
- **On Windows the cost is rg's per-file work on named files, not the process starts.** One rg over 1,000 files of a package named on its command line took 136 to 187 ms, against 48 to 56 ms for its own walk of the same package; ten runs of 100 named files took 274 to 316 ms. A run of a 32,000-unit batch (about 1,400 files) took about 300 ms and one of 16,000 units about 150 ms, so halving the batch doubled the runs and left the total even. `BATCH_COMMAND_LINE` stays 32,000 on Windows, where `CreateProcessW` sets the bound.
- **On Linux the process starts weigh, so a larger batch helps.** From 32,000 to 96 KiB of argv the runs fell from 196 to 64 and the total from 1.56 to 0.82 s; 128 KiB gained another 0.08 s. `BATCH_COMMAND_LINE` is 96 KiB on POSIX, the most that leaves the environment 32 KiB of the 128 KiB Linux never sets `ARG_MAX` below (`fs/exec.c` `bprm_stack_limits`, which also counts each argument's pointer); macOS allows 1 MiB.
- **The first match waits for the first run.** It came after 0.28 s on Windows, the walk's first full batch plus its rg run, and after 0.14 s with 16,000-unit batches. On this warm tree a full batch fills well within `WALK_FLUSH_MS`, so the flush, which sends a batch whose first file waited 200 ms at the next folder listed, matters only on a slow file system, where it starts the first rg early instead of after a full batch.

#### Runs at once

rg takes no list of files to search (BurntSushi/ripgrep#273; PR #3462 adds one and is not in 15.0.0), so each batch is named on its command line, and rg stats every path named there on one thread before its search threads start (the ignore crate's `WalkParallel::visit`, its loop over the roots). On this Windows machine that stat costs about 115 µs a file, against about 62 µs for Node's `lstat` of the same file (Kaspersky is installed), so a batch's time is mostly those stats; several runs at once share them out, as `xargs -P` does.

rg alone first, with `rg-parallel.mjs`: the 200,000 `.ts` files of the 200 packages, named in batches within a command-line budget (98,304 on Linux), each run with rg's own thread count and the walked flags (`--json --no-config --no-ignore --no-mmap --crlf --ignore-case --fixed-strings`), k runs at once, started with Node's `spawn` outside the launcher, against one rg walking the 200 package folders itself; no walk process and no Damocles code. Median of 3, the same machine and day.

| OS | rg's own walk | 1 at once | 2 at once | 4 at once | 8 at once |
|---|---|---|---|---|---|
| Windows | 7.1 s | 49.0 s | 26.4 s | 24.8 s | 21.3 s |
| Linux | 0.13 s | 0.58 s | 0.35 s | 0.24 s | 0.23 s |

End to end, with a second harness built as the first: the Search runner (`createSearchRunner`) as the first table's row, and the agent's Grep (`createGrepTool`, with stand-ins for pi's output helpers, which every variant pays alike) on the whole tree (no excludes: 230,200 files with `node_modules` and the 20,000-file folder, `.git` skipped), once with its default `limit` of 100, which ends the search at the 101st match, and once with 1,000, which searches every file. The number of runs was set through `os.availableParallelism`, which `walkedRgRuns()` reads. Grep's "rg's own walk" rows ran `rg --json --line-number --color=never --hidden -- needle .` in the tree, as pi's own grep runs it, killed at the match past the limit. First match is not measured for Grep, which returns at its end. Windows: 3 rounds after a warm-up of each variant; Linux: 5. Medians, ranges minimum to maximum, alternating order, an idle second before each run. Measured 2026-11-18 on the machines of the first table.

| OS | Variant | Matches | First match ms | Range ms | Total ms | Range ms |
|---|---|---|---|---|---|---|
| Windows | Search: rg's own walk | 200 | 67 | 66-257 | 6,619 | 6,343-7,029 |
| Windows | Search runner, 1 run at once | 200 | 303 | 279-303 | 48,333 | 43,161-51,220 |
| Windows | Search runner, 2 runs at once | 200 | 475 | 458-596 | 32,944 | 32,396-33,297 |
| Windows | Search runner, 4 runs at once | 200 | 436 | 297-1,088 | 27,426 | 24,307-30,789 |
| Windows | Grep, limit 100: rg's own walk | 100 | n/a | n/a | 3,868 | 3,861-4,266 |
| Windows | Grep, limit 100, 1 run at once | 100 | n/a | n/a | 29,997 | 27,091-31,634 |
| Windows | Grep, limit 100, 4 runs at once | 100 | n/a | n/a | 16,437 | 14,866-21,839 |
| Windows | Grep, limit 1,000: rg's own walk | 200 | n/a | n/a | 8,021 | 6,868-8,394 |
| Windows | Grep, limit 1,000, 1 run at once | 200 | n/a | n/a | 56,314 | 53,492-60,641 |
| Windows | Grep, limit 1,000, 4 runs at once | 200 | n/a | n/a | 31,579 | 29,975-34,968 |
| Linux | Search: rg's own walk | 200 | 7 | 6-8 | 150 | 141-162 |
| Linux | Search runner, 1 run at once | 200 | 17 | 16-27 | 961 | 876-983 |
| Linux | Search runner, 2 runs at once | 200 | 18 | 16-20 | 544 | 479-569 |
| Linux | Search runner, 4 runs at once | 200 | 19 | 16-29 | 366 | 341-504 |
| Linux | Grep, limit 100: rg's own walk | 100 | n/a | n/a | 73 | 72-86 |
| Linux | Grep, limit 100, 1 run at once | 100 | n/a | n/a | 562 | 517-649 |
| Linux | Grep, limit 100, 4 runs at once | 100 | n/a | n/a | 247 | 241-287 |
| Linux | Grep, limit 1,000: rg's own walk | 200 | n/a | n/a | 163 | 154-196 |
| Linux | Grep, limit 1,000, 1 run at once | 200 | n/a | n/a | 1,018 | 948-1,200 |
| Linux | Grep, limit 1,000, 4 runs at once | 200 | n/a | n/a | 428 | 397-526 |

Findings:

- **Four runs at once take a little over half the time of one on Windows, and under half on Linux.** Search: 27.4 s against 48.3 s on Windows, 0.37 s against 0.96 s on Linux; Grep of every file: 31.6 s against 56.3 s, and 0.43 s against 1.02 s; Grep to its limit: 16.4 s against 30.0 s, and 0.25 s against 0.56 s. Two runs gave most of the Windows gain (Search 32.9 s), as with rg alone (26.4 s at 2, 24.8 s at 4).
- **The one-at-a-time Search runner took 48 s here and 41 s in the first table**, the same harness method on the same day; its range here was 43 to 51 s.
- **On Windows the first match comes later with runs at once.** 0.44 to 0.48 s at 2 or 4 runs, against 0.30 s with one: the first batches start together and share the stats. On Linux it stayed between 17 and 19 ms.
- **Search still takes about four times rg's own walk on Windows** (27 s against 6.6 s), and Grep of every file about four times (32 s against 8 s). The cause is in rg: the stat of every named path on one thread, which more runs share only up to about 4 (21.3 s at 8 runs of rg alone), since the opens stop scaling past 2 to 4 processes. Only rg's own walk avoids it, and Damocles does not use that walk because on Windows it opens a link's target ("Tool overrides" in `docs/invariants.md`). A file-list input in rg (#273, PR #3462) is what would let one rg take a whole listing. On Linux the gap is about 2.5 times (0.37 s against 0.15 s).

## Process launcher (S2 measurements)

libuv's `uv_spawn` calls `CreateProcessW` synchronously on the thread that starts a process, so every start Damocles owns is meant to run on the process launcher (`src/core/process-launcher/`, `docs/invariants.md` "Shell cancellation and process lifetime"). The host thread pays one `postMessage` per request.

Spike, 2026-10-20: Intel Core i7-13650HX, Windows 11 Pro 10.0.26200, Node 24.21.0, git 2.56.0.windows.2 at its absolute path, `git --version` per start.

- **Gates, all passed.** koffi's job-object API loads in a worker thread, and a child assigned right after `spawn` is in the job (`IsProcessInJob`). A job created on one worker (koffi 3 returns the HANDLE as a BigInt) assigns a child started on another worker. `TerminateJobObject`, called from the first worker, killed the shell and its children (`ping` and its `conhost`). A session job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, created on one worker of a separate Node process and holding a child another worker started, killed that child when the process exited. So session jobs are shared by raw handle value, not pinned to one worker, on Windows.
- **Start blocking, 500 sequential starts.** On this machine a start holds its thread for tens of milliseconds and, now and then, for seconds, on a worker as on main; on a worker it no longer holds the UI thread.

| Thread that calls `spawn()` | p50 ms | p99 ms | max ms |
|---|---|---|---|
| main | 85.9 | 249.9 | 2265.4 |
| worker | 67.1 | 241.6 | 2143.9 |

- **Throughput, 200 starts split over k workers starting concurrently,** measured before the spawn lock, which now runs Windows starts' `CreateProcessW` one at a time ("Concurrent starts on Windows"). Starts per second peak at 4 workers; 8 adds nothing and doubles each start's blocking. The main thread's event loop delay stayed under 32 ms throughout.

| Workers | Starts/s | Block p50 ms | Block p99 ms | Block max ms | Main loop delay max ms |
|---|---|---|---|---|---|
| 1 | 6.2 | 46.6 | 265.8 | 297.4 | 31.1 |
| 2 | 15.4 | 36.9 | 113.8 | 113.9 | 25.9 |
| 4 | 24.8 | 48.7 | 89.0 | 89.2 | 18.0 |
| 8 | 22.4 | 101.8 | 168.3 | 171.9 | 24.5 |

- **Constants** (`pool.ts`): `POOL_SIZE` 4, where throughput peaks; up to it a start gets a worker with no live process, so a start blocked for seconds delays no other process's output. `MAX_WORKERS` 8: past `POOL_SIZE` a worker starts only while every worker is inside a start, which only a start blocked for seconds causes; past 8, starts queue. `MAX_UNACKED_BYTES` 1 MiB, as the pty host's acknowledgement.
- **The built worker** (`dist/process-launcher-worker.js`, 200 starts driven from main): every start got its own job object, so koffi loads in the bundle; main's `postMessage` per start p50 0.22 ms, max 9.9 ms; start to close p50 53.8 ms.
- **Chat review**: a recompute over 50 changed files starts one `git cat-file --batch` for their checkpoint repo instead of one `git show` per file side (`chat-review.test.ts`).

Measuring again: the spike scripts are not kept; time `spawn()` with `process.hrtime.bigint()` around the call on main and inside a `worker_threads` worker, with `git --version` at its absolute path.

### Starts outside the launcher

Every process start Damocles owns goes through the launcher: git (source control, checkpoints and rewind with their `tasklist` and `ps` liveness probes, chat review, the team fingerprint, the `mcp.local.json` ignore check, the desktop startup probe); the Bash and PowerShell tools, the hooks runner and the POSIX shell sentinel, which the launcher worker owning its session job starts, with `killProcessTree`'s `taskkill` fallback; MCP stdio servers (`mcp/launcher-transport.ts`), the npx resolver's npm calls and `config-value.ts`'s `!command` values; ripgrep for `grep`, which matches over the files the walk lists, and for Search; the walk processes of Damocles Core, the daemon and the extension host (`startWalkChild`), which run every walk of the `@` list, Grep and Glob, and a remote project's Quick Open and Search (main's own walk processes are utility processes, below); `wsl.exe` for the terminal profiles; voice (the sidecar, the recorder, the lock file's `icacls`, the graceful `taskkill`, the runtime probes and `python-installer.ts`); and the desktop login-shell read at startup (`mergeLoginShellEnv`). Lint refuses a `child_process` or `cross-spawn` import outside the files allowed to start processes ("Synchronous calls (lint)" above, `docs/invariants.md` "Shell cancellation and process lifetime"). On desktop, main and Damocles Core each install their own pool: core's starts the engine's processes (git, the shell tools and hooks, MCP, voice, `grep`'s ripgrep, its walk processes), and main's starts the few main runs (Search's ripgrep, terminal profiles, the login-shell read and the startup git probe).

These stay outside, each for its reason:

- **The voice sidecar's `killChildSync`** runs `taskkill` with `spawnSync` on the host thread: VS Code's deactivate does not await, so a start on the launcher might never run. It also asks the launcher worker to terminate the sidecar's job, which it does in parallel while the process lives on.
- **pi's own starts:** its `!command` API keys and headers in `models.json` and `!command` keys in `auth.json`, which pi runs with async `spawn` (patch 003, `patches/README.md`), built-in tools Damocles does not replace and users' pi extensions. Damocles patches pi only to carry a fix upstream has not released yet; these starts run in Damocles Core, so a synchronous one blocks the engine, never the window.
- **Libraries that start their own processes:** Patchright's driver and Chrome (browser tools, on by default) and electron-updater's installer at quit. Neither takes a spawn function.
- **Compass's git**, which runs `execFile` on the Compass worker thread (`src/core/compass/git.ts`, which no host bundle includes) under the spawn lock ("Concurrent starts on Windows" below).
- **Electron utility processes** (Damocles Core, the pty and formatter hosts, and main's walk processes, `main/walk-process.ts`), which Chromium starts on its own launcher thread; node-pty's shells start in the pty host, off every UI and chat thread. Main's walk processes are utility processes rather than launcher children because a launcher child receives any handle Chromium's launcher marks inheritable while their starts overlap, and a walk process may live long ("Concurrent starts on Windows" below).
- **The design renderer** (`src/desktop/main/design/design-renderer-start.ts`, `PROCESS_STARTERS_MAIN`), the app's executable started again to hold core's design render windows (`docs/invariants.md` D85). Main starts it with `child_process.spawn` on its own thread, because its IPC channel belongs to the thread that starts it and the launcher has none; `lockThreadSpawns` holds the spawn lock around the start. It starts at the first render of a session at most once per renderer life, so the one `CreateProcessW` on the UI thread is rare.
- **The daemon's children and the bridge's daemon start** (`src/desktop/daemon/process-starts.ts`, the one file there lint allows). The daemon forks the pty host, the formatter hosts and Damocles Core with `child_process.fork` and `serialization: 'advanced'` from its main thread, because an IPC channel belongs to the thread that forked and the launcher has neither fork nor IPC. The attach bridge starts the daemon detached (setsid on POSIX, `Win32_Process.Create` through WMI on Windows, so it leaves the caller's job object). Each start runs inside `withSpawnLock`; every other daemon start (ripgrep, git, the login-shell read, `icacls`, `whoami`) goes through the daemon's own launcher pool.
- **The `damocles` command's start of the app** (`src/desktop/cli/cli.ts`, `PROCESS_STARTERS_CLI` in `eslint.config.mjs`). `dist/cli.js` is a program of its own, which `resources/bin/damocles` or `damocles.cmd` runs under the app's binary as Node outside any Damocles process, so there is no launcher pool to use and no app thread a start could block. It makes one start, the app with the request on its command line, detached with its stdio ignored so the app outlives the terminal, and then exits or polls its `--wait` marker. The rest of `src/desktop/cli` starts nothing.

### Concurrent starts on Windows

On Windows, two threads of one process must never be inside a process start at the same time. libuv 1.52.1, which Node 24.21.0 ships (in Electron 44.7 and in VS Code 1.143's Electron 43.7), opens a child's stdio ends as inheritable handles (`uv__create_stdio_pipe_pair` and `uv__create_nul_handle` in `src/win/process-stdio.c`), calls `CreateProcessW` with `bInheritHandles` set (`src/win/process.c`) and closes them in `uv__stdio_destroy` before `uv_spawn` returns. A `CreateProcessW` with `bInheritHandles` set on another thread inside that window gives its own child copies of those ends (libuv/libuv#1490; Raymond Chen, "The case of the redirected standard handles that won't close even though the child process has exited"). When that child lives long, it holds the first child's stdout open after the first child exits, so the first child's `close` never comes. `git-runner.ts` settles a call on `exited` and `closed`, so a git read started beside an MCP stdio server (`node mcp-server.js`) hung until the server exited, and every quit waited out the close timeout. One thread cannot interleave its own starts; the race arrived with the worker pool.

The fix is the discipline of Go's `syscall.ForkLock` and Rust's `CREATE_PROCESS_LOCK` (`library/std/src/sys/process/windows.rs`, after Microsoft KB315939): one lock per process around process creation (`src/core/process-launcher/spawn-lock.ts`). It is one `Int32` in a `SharedArrayBuffer` that the first thread to ask creates (the host thread, in practice) and hands to every worker that starts processes (`LauncherWorkerData.spawnLock`, `CompassWorkerData.spawnLock`). `withSpawnLock` holds it only around the synchronous start: an async `spawn` returns after `uv_spawn` closed the child's ends, so `CreateProcessW` still runs on the worker, and the host thread waits only when it starts a process itself. `createShellJob` still follows `spawn` directly, outside the lock. A worker waiting for the lock is blocked like one inside a start, and the pool counts it as one. Starts no longer overlap inside `CreateProcessW`, so on Windows the throughput table above, measured without the lock, overstates what concurrent starts reach. A worker terminated inside a start skips its `finally`, so `releaseSpawnLockOnExit` frees a lock the dead thread still holds (the lock word is its `threadId + 1`). `launcher.test.ts` > "closes every short process started beside long-lived ones" starts 4 long-lived and 8 short processes at once, for 6 rounds; without the lock the first round left 6 of 8 short processes unclosed, in every run.

libuv 1.53.0 passes `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to `CreateProcessW` (libuv/libuv#5100), so a libuv child inherits only its own stdio; once every host Damocles supports runs a Node with libuv 1.53.0 or later, the lock has nothing left to prevent. Node exposes neither the handle list nor libuv's locking, so until then the lock is the only fix.

POSIX takes no lock, and `withSpawnLock` and `lockThreadSpawns` return at once there. On Linux libuv creates every stdio descriptor close-on-exec atomically (`pipe2(O_CLOEXEC)`, `socketpair(SOCK_CLOEXEC)` in `uv_socketpair`), and the forked child `dup2`s only the descriptors it names; on macOS it starts children with `posix_spawn` and `POSIX_SPAWN_CLOEXEC_DEFAULT`, which closes every descriptor the child is not given. Linux libuv closes nothing else in the child, though, so a child also keeps every descriptor of its parent that lacks `FD_CLOEXEC`. Node marks the ones it inherited at startup only up to the first gap past descriptor 15 (`uv_disable_stdio_inheritance`), and Electron main's Chromium opens many without it (its sockets, the DevTools server's among them, and the profile's cache and LevelDB files), which reach every process main starts on Linux. A short-lived child drops them as it exits; the loopback bridge passes them to the daemon it starts, which closes them first ("Remote daemon and wire" in `docs/invariants.md`).

What holds the lock, per thread that starts processes:

- **Launcher workers** (Damocles Core, desktop main, the extension host): every start, and `killProcessTree`'s `taskkill` fallback. The POSIX sentinel's start takes none.
- **The Compass worker:** its git starts with `execFile`, since an `execFileSync` under the lock would hold every other start for the whole git run.
- **The voice sidecar's `killChildSync`:** its `spawnSync` holds the lock for the whole `taskkill` run, at deactivate only.
- **The daemon's main thread:** `lockThreadSpawns` before its pool, and `withSpawnLock` around each fork and detached start in `process-starts.ts`.
- **Host threads** (Damocles Core's, desktop main's and the extension host's): `lockThreadSpawns`, called before the pool is installed, takes the lock around every async `child_process` start on that thread through Node's `child_process.spawn` tracing channel (experimental, Node 24.15 and later): pi's async starts and users' pi extensions, Patchright's Chrome, electron-updater's installer and, in VS Code, every other extension's starts on the extension host thread. Such a start waits only while another thread is inside a start; before the pool, Damocles' own starts blocked that thread as long. VS Code unsubscribes it at deactivate. A thread's holds nest, so a start under `withSpawnLock` on a subscribed thread does not wait on its own hold. On a host whose Node predates 24.15 the channel never fires and these starts stay outside the lock.

What does not, and what that costs:

- **Synchronous starts by code Damocles does not own on a host thread,** which publish no channel event: pi's `where` lookups for its shell (`utils/shell.js`, `spawnSync` with a 5 s timeout) and other extensions' synchronous starts in the extension host. The window is one `uv_spawn`, about one `CreateProcessW` (tens of milliseconds, seconds at worst, as measured above). A launcher start whose `CreateProcessW` lands in it gives its child the lookup's stdout; if that child lives long, pi's `spawnSync` waits until its timeout kills the lookup and closes the pipes (`SyncProcessRunner::Kill`), so Core's thread is blocked that long and the lookup finds nothing. The other way round, the lookup inherits the launcher child's pipe ends and delays that child's `close` until it exits. pi's `!command` config values are async starts (patch 003) under the host thread's lock above; its synchronous resolvers (`resolve-config-value.js`: `spawnSync` or `execSync`, 10 s timeout) are left only to its built-in MCP extension (`extensions/mcp/runtime.js`), which Damocles never loads. Damocles' own `!command` values (MCP config, `config-value.ts`) start on the launcher.
- **Chromium's launcher thread** in desktop main: `base::LaunchProcess` passes `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so Chromium's children inherit nothing of ours. It marks the handles it passes inheritable just before its `CreateProcessW`, so a main launcher start overlapping a Chromium launch can receive one of them; main's launcher starts (Search's ripgrep, terminal profiles, the login-shell read, the git probe) are short-lived, so such a copy lives only as long as they do. Main's walk processes, which may live long, are utility processes that Chromium's launcher itself starts with its handle list, so they receive none.
