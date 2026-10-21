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

The profile rolls over to a new 10 s segment on a heartbeat. A roll-over cannot run during a stall, so the segment running when a stall began covers all of it. Stopping a segment holds the thread for time that grows with the segment; a stop over 50 ms logs `[stall-monitor] segment stop took N ms`.

A stall sampled busy for under 100 ms keeps no profile and logs one of two readings:

- **The process was not scheduled**: the main thread ran on a CPU for under 10% of the blocked time. The OS did not run it: system load, a sleep the power monitor missed, or OS throttling.
- **Native work on the UI thread**: the main thread kept a CPU busy, but the profiler took no JavaScript samples, as in native code Electron or Chromium runs on that thread.

On macOS neither monitor runs a profiler (`processProfiler`) and logs only the blocked time and the main thread's CPU time. With V8 sampling main, two launches on the release workflow's macOS arm64 runners hung at the startup `git --version` spawn: the probe's own timeout never fired, and `app.close()` could not quit the app. No Windows or Linux launch hung.

### Tools

Each script in `scripts/perf/` starts with its usage.

- `node scripts/perf/stall-report.mjs <logsDir>` groups the `[stall]` entries of `Damocles.log` and `Damocles_Core.log` (and their rotated copies) by cause (the heaviest stack's Node API frame and its nearest named callers) and prints counts, total, median, p90 and max, plus the count of slow segment stops, one block per process (`main process`, `core process`, named by the file). Pass a profile from `logs/stalls/core/` to `cpuprofile-runs.mjs` for a core stall.
- `node scripts/perf/cpuprofile-runs.mjs <file.cpuprofile> [function]` lists the contiguous sample runs under a function (default `spawn`) with their calling stacks, which tells one slow call apart from many fast ones.
- `node scripts/perf/profile-desktop-main.mjs --seconds <n> [--from <userData>] [--project <folder>] [--sessions <n>] [--out <dir>] [--interval-us <n>]` profiles the dev build's main process, not Damocles Core, from its first instruction, sampling every `--interval-us` microseconds (default 1000). Run `npm run build:desktop` first, and on Windows `node scripts/brand-dev-electron.mjs`, which writes the Electron copy the dev build runs on (`npm run dev:desktop` runs both). It runs a fresh temporary `--user-data-dir`, copies `projects.json`, `trusted-folders.json` and `window-layout.json` from `--from`, and restores the project's `--sessions` most recently modified sessions. The packaged app cannot be profiled this way: its `enableNodeCliInspectArguments` fuse is off.

### First launch of a new Electron binary (Windows)

A `[stall]` whose heaviest stack is `startThread < Worker node:internal/worker` (core spent its time inside `new Worker()`, with little main-thread CPU) on the first launch of a binary file is the operating environment, not Damocles. Measured 2026-10-21 on the i7-13650HX, Windows 11 Pro 10.0.26200, Electron 44.7.0, with Kaspersky 21.26 real-time protection on and the Microsoft Defender service not running; dev launches ran the dev build on a copy of `dist-damocles-dev`, packaged ones on a copy of the installed 3.7.0.

- **Cold launches** (the first launch of an Electron binary file this machine had not run, either a byte-identical copy at a new path or a copy with bytes appended): all 14 dev launches lost 2.2 to 3.6 s in one window within the first 5 s. In 11 it landed on core's main thread in a worker start (`[stall]` 2,188 to 2,863 ms); in the others it landed on the chats' pages (`panel.html→ready` 3.0 to 4.1 s, against 0.25 to 0.9 s) and on git calls started in it (2.9 to 3.5 s, against 0.05 to 0.65 s on the warm relaunch). Packaged copies with a new `Damocles.exe`: 2 of 3 first launches lost the same window, once in a worker start (2,505 ms, same stack) and once between main forking core and core's first log line (2.9 s, against 0.5 s).
- **Warm launches** had none: 5 relaunches of cold copies, and 22 launches on the usual `dist-damocles-dev`, 3 of them the first after `npm run build:desktop` (twice after `npm run build` too) and 12 on a freshly written copy of every `dist` file. Core's worker starts took 0.6 to 17 ms.
- **What the thread waited on**: core's main thread was in a kernel wait (thread state Waiting, wait reason Executive; user-mode waits report UserRequest or WrAlertByThreadId) while the thread it was creating already existed in state Initialized. In the same window an unrelated `node.exe` took 2,884 and 3,036 ms to start a worker (16 ms at most in the warm control run), a process list query (`NtQuerySystemInformation`) and a minidump of core returned only when core's worker start did, and `avp.exe` used about one core: 6.6 s of CPU over the 7 s around a cold launch's start, against 1.9 s around the warm relaunch's and 0.5 s per idle 10 s. Thread starts stalled outside Damocles too.
- **Ruled out**: the loader lock (a worker holding it with `LdrLockLoaderLock` did not delay `new Worker()` on the parent, 0.7 to 5.4 ms, the new thread waited instead), native addons (core's main thread loads none at startup, `koffi.node` loads on launcher workers in 0.5 to 2.2 ms, and freshly written 25 MB and 3 MB DLLs loaded in 54 to 90 ms beside worker starts of at most 2.6 ms), and the build (it writes no `.node` or `.dll`; `brand-dev-electron.mjs` rewrites `dist-damocles-dev` only when its stamp changes).
- **Not established**: whether Kaspersky causes the window (it was not turned off), and which step of the app's start opens it: never-seen copies run as Node (`ELECTRON_RUN_AS_NODE`) opened none, as 637 worker starts over 15 s each took under 50 ms, and 4 child processes of the same binary delayed an unrelated process's worker start by 228 ms at most. The 5,506 ms smoke stall that prompted this ran on a `dist-damocles-dev` unchanged since 2026-10-15, as the first dev launch after a reboot 22 minutes earlier; launches after a reboot were not measured.

Users see it once per binary file: the first launch after an install or update, when a thread or process start lands in the window (a delayed first chat, a slow first page, slow first git calls). Core cannot step around it: its worker starts, its git starts and the chats' page loads all waited in the window, and so did a worker start in an unrelated process.

### Synchronous calls (lint)

`damocles/no-sync`, a local rule in `eslint.config.mjs`, fails `npm run lint` on a call to any `*Sync` function or method (`readFileSync`, `existsSync`, `execFileSync`, `spawnSync`, ...) in the trees `NO_SYNC_FILES` lists (`src/core`, `src/desktop/main`, `src/desktop/core-host`, `src/desktop/core-protocol`, `src/desktop/local-services`, `src/platform`, `src/shared` and `src/vscode`), the code that runs on the desktop UI thread, Damocles Core's thread or the VS Code extension host's thread. A `this._with…Sync(op)` call, which chains `op` on one of `PiRuntime`'s async queues, is not flagged. Tests (`__tests__` folders and `*.test.ts` files wherever they sit), benches and `WORKER_ONLY_FILES` (files only worker threads load, listed one by one) are exempt; `scripts/__tests__/no-sync-lint-scope.test.ts` fails when a host bundle includes a listed file. It is local because `eslint-plugin-n`'s `n/no-sync` throws on TypeScript files without typed linting.

- **Burn-down list.** `eslint-suppressions.json` holds the calls that predate the rule. ESLint fails on a suppression no longer used, so a change that removes a synchronous call also runs `npx eslint "src/**/*.{ts,vue}" --prune-suppressions`. Suppressions count per file per rule, so swapping one synchronous call for another in the same file passes.
- **Permanent exceptions** carry `// eslint-disable-next-line damocles/no-sync -- <reason>`: the session lease's `lockSync` and `clearEndedHoldersLock`'s `statSync`, `renameSync` and `rmSync` (a claim never waits), `readLiveSessionMetadata`'s `statSync` (stat and snapshot run back to back), the voice sidecar's `killChildSync` (VS Code's deactivate does not await), and the desktop log sink's folder creation and write at exit or dispose.
- **Not caught:** `node:sqlite` calls, which are synchronous by design, and synchronous work inside an async API: npm `tar` inflates each 16 MB read with `minizlib` on the calling thread, so the voice installer unpacks the Python archive on a worker (`voice/runtime/extract-worker.ts`, `dist/voice-extract-worker.js`), which a failed or cancelled extraction ends before removing the partial `python/` folder. pip's output is kept as a 64 KiB tail per stream.
- **Process starts** have a rule of their own: `child_process`, `node:child_process` and `cross-spawn` may be imported only by tests and the files `PROCESS_STARTERS_CORE` and `PROCESS_STARTERS_DESKTOP` in `eslint.config.mjs` list (`scripts/__tests__/child-process-lint-scope.test.ts` probes each top-level folder of every tree under `src` but the two utility process hosts, renderers and workers included); everything else starts through the process launcher, whose workers keep the synchronous `CreateProcessW` off these threads.

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

2026-10-20, i7-13650HX, Windows 11, dev build (`npm run build:desktop`) after slices S1 to S8, `profile-desktop-main.mjs --seconds 40 --project C:\GameDev\damocles --sessions 2` (a project with 140 sessions and a worktree folder with 544), each launch with a fresh userData. The session index file was new in launch 1, so its 684 files all missed; launches 2 and 3 still parsed the misses launch 1's 40 s did not reach. Only launch 1 ran with a cold disk cache for the new bundles; none ran after a reboot, so none is a cold OS start.

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

Every process start Damocles owns goes through the launcher: git (source control, checkpoints and rewind with their `tasklist` and `ps` liveness probes, chat review, the team fingerprint, the `mcp.local.json` ignore check, the desktop startup probe); the Bash and PowerShell tools, the hooks runner and the POSIX shell sentinel, which the launcher worker owning its session job starts, with `killProcessTree`'s `taskkill` fallback; MCP stdio servers (`mcp/launcher-transport.ts`), the npx resolver's npm calls and `config-value.ts`'s `!command` values; ripgrep for `grep`, `find`, the `@` file list, Search and Quick Open; `wsl.exe` for the terminal profiles; voice (the sidecar, the recorder, the lock file's `icacls`, the graceful `taskkill`, the runtime probes and `python-installer.ts`); and the desktop login-shell read at startup (`mergeLoginShellEnv`). Lint refuses a `child_process` or `cross-spawn` import outside the files allowed to start processes ("Synchronous calls (lint)" above, `docs/invariants.md` "Shell cancellation and process lifetime"). On desktop, main and Damocles Core each install their own pool: core's starts the engine's processes (git, the shell tools and hooks, MCP, voice, the `@` file list), and main's starts the few main runs (Search, Quick Open, terminal profiles, the login-shell read and the startup git probe).

These stay outside, each for its reason:

- **The voice sidecar's `killChildSync`** runs `taskkill` with `spawnSync` on the host thread: VS Code's deactivate does not await, so a start on the launcher might never run. It also asks the launcher worker to terminate the sidecar's job, which it does in parallel while the process lives on.
- **pi's own starts:** its `!command` credential `spawnSync`, built-in tools Damocles does not replace and users' pi extensions. Changing pi is a non-goal; they run in Damocles Core, so a slow one blocks the engine, never the window.
- **Libraries that start their own processes:** Patchright's driver and Chrome (browser tools, off by default) and electron-updater's installer at quit. Neither takes a spawn function.
- **Compass's git**, which runs `execFile` on the Compass worker thread (`src/core/compass/git.ts`, which no host bundle includes) under the spawn lock ("Concurrent starts on Windows" below).
- **Electron utility processes** (Damocles Core and the pty and formatter hosts), which Chromium starts on its own launcher thread; node-pty's shells start in the pty host, off every UI and chat thread.

### Concurrent starts on Windows

On Windows, two threads of one process must never be inside a process start at the same time. libuv 1.52.1, which Node 24.21.0 ships (in Electron 44.7 and in VS Code 1.143's Electron 43.7), opens a child's stdio ends as inheritable handles (`uv__create_stdio_pipe_pair` and `uv__create_nul_handle` in `src/win/process-stdio.c`), calls `CreateProcessW` with `bInheritHandles` set (`src/win/process.c`) and closes them in `uv__stdio_destroy` before `uv_spawn` returns. A `CreateProcessW` with `bInheritHandles` set on another thread inside that window gives its own child copies of those ends (libuv/libuv#1490; Raymond Chen, "The case of the redirected standard handles that won't close even though the child process has exited"). When that child lives long, it holds the first child's stdout open after the first child exits, so the first child's `close` never comes. `git-runner.ts` settles a call on `exited` and `closed`, so a git read started beside an MCP stdio server (`node mcp-server.js`) hung until the server exited, and every quit waited out the close timeout. One thread cannot interleave its own starts; the race arrived with the worker pool.

The fix is the discipline of Go's `syscall.ForkLock` and Rust's `CREATE_PROCESS_LOCK` (`library/std/src/sys/process/windows.rs`, after Microsoft KB315939): one lock per process around process creation (`src/core/process-launcher/spawn-lock.ts`). It is one `Int32` in a `SharedArrayBuffer` that the first thread to ask creates (the host thread, in practice) and hands to every worker that starts processes (`LauncherWorkerData.spawnLock`, `CompassWorkerData.spawnLock`). `withSpawnLock` holds it only around the synchronous start: an async `spawn` returns after `uv_spawn` closed the child's ends, so `CreateProcessW` still runs on the worker, and the host thread waits only when it starts a process itself. `createShellJob` still follows `spawn` directly, outside the lock. A worker waiting for the lock is blocked like one inside a start, and the pool counts it as one. Starts no longer overlap inside `CreateProcessW`, so on Windows the throughput table above, measured without the lock, overstates what concurrent starts reach. A worker terminated inside a start skips its `finally`, so `releaseSpawnLockOnExit` frees a lock the dead thread still holds (the lock word is its `threadId + 1`). `launcher.test.ts` > "closes every short process started beside long-lived ones" starts 4 long-lived and 8 short processes at once, for 6 rounds; without the lock the first round left 6 of 8 short processes unclosed, in every run.

libuv 1.53.0 passes `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to `CreateProcessW` (libuv/libuv#5100), so a libuv child inherits only its own stdio; once every host Damocles supports runs a Node with libuv 1.53.0 or later, the lock has nothing left to prevent. Node exposes neither the handle list nor libuv's locking, so until then the lock is the only fix.

POSIX takes no lock, and `withSpawnLock` and `lockThreadSpawns` return at once there. On Linux libuv creates every stdio descriptor close-on-exec atomically (`pipe2(O_CLOEXEC)`, `socketpair(SOCK_CLOEXEC)` in `uv_socketpair`), and the forked child `dup2`s only the descriptors it names; on macOS it starts children with `posix_spawn` and `POSIX_SPAWN_CLOEXEC_DEFAULT`, which closes every descriptor the child is not given.

What holds the lock, per thread that starts processes:

- **Launcher workers** (Damocles Core, desktop main, the extension host): every start, and `killProcessTree`'s `taskkill` fallback. The POSIX sentinel's start takes none.
- **The Compass worker:** its git starts with `execFile`, since an `execFileSync` under the lock would hold every other start for the whole git run.
- **The voice sidecar's `killChildSync`:** its `spawnSync` holds the lock for the whole `taskkill` run, at deactivate only.
- **Host threads** (Damocles Core's, desktop main's and the extension host's): `lockThreadSpawns`, called before the pool is installed, takes the lock around every async `child_process` start on that thread through Node's `child_process.spawn` tracing channel (experimental, Node 24.15 and later): pi's async starts and users' pi extensions, Patchright's Chrome, electron-updater's installer and, in VS Code, every other extension's starts on the extension host thread. Such a start waits only while another thread is inside a start; before the pool, Damocles' own starts blocked that thread as long. VS Code unsubscribes it at deactivate. A thread's holds nest, so a start under `withSpawnLock` on a subscribed thread does not wait on its own hold. On a host whose Node predates 24.15 the channel never fires and these starts stay outside the lock.

What does not, and what that costs:

- **Synchronous starts by code Damocles does not own on a host thread,** which publish no channel event: pi's `!command` config values (`resolve-config-value.js`: on Windows `spawnSync` of the configured shell, else `execSync`, both with a 10 s timeout; `resolveConfigValue` caches a command's value for the process, while `models.json` keys and headers run it on every resolve), pi's `where` lookups for its shell, and other extensions' synchronous starts in the extension host. The window is one `uv_spawn`, about one `CreateProcessW` (tens of milliseconds, seconds at worst, as measured above). A launcher start whose `CreateProcessW` lands in it gives its child the command's stdout; if that child lives long, pi's `spawnSync` waits until its 10 s timeout kills the command and closes the pipes (`SyncProcessRunner::Kill`), and returns no value, so Core's thread is blocked 10 s and that value resolves to nothing. The other way round, the command inherits the launcher child's pipe ends and delays that child's `close` until the command exits. Damocles' own `!command` values (MCP config, `config-value.ts`) start on the launcher.
- **Chromium's launcher thread** in desktop main: `base::LaunchProcess` passes `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so Chromium's children inherit nothing of ours. It marks the handles it passes inheritable just before its `CreateProcessW`, so a main launcher start overlapping a Chromium launch can receive one of them; main's starts (Search, Quick Open, terminal profiles, the login-shell read, the git probe) are short-lived, so such a copy lives only as long as they do.
