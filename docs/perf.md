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
| `ready.total` | the `ready` handler up to posting the prompt history; the session start and model request that follow are not included | `path=restore\|fresh\|switch` |
| `sessions.list` | `listPiSessions`, one line per folder | `files`, `misses`, `hits` |
| `sessions.upsert` | list upsert, only above 20 ms; a watcher event whose file matches the cache logs none | `source=live\|file`, `applied` |
| `promptHistory` | `extractPiPromptHistory` | `files` (opened), `prompts` |
| `pi.import` | dynamic import of pi | |
| `replay.resolve`, `replay.open`, `replay.reconstruct`, `replay.usage`, `replay.hydrate`, `replay.post`, `replay.total` | `loadPiSessionHistory` | `entries`, `items`, `agents`; `approxChars` only with `damocles.debug` on |
| `runtime.init`, `folderRuntime.create` | pi runtime and per-folder runtime creation | |
| `start.syncProviders`, `start.createRuntime`, `start.total` | `PiSession.start()` | `timedOut`, `resumed` |
| `boot.readySent` | webview, from navigation start | |
| `boot.resources` | webview, ms is when the last boot chunk finished | `index.js`, `vendor.js`, `shiki-core.js` as duration/decoded size (0KB means the size was not exposed) |
| `replay.ingest` | webview, `sessionCleared` to the replay's `done`; a failed load logs none | `items` (`errorReplay` not counted) |
| `replay.painted` | webview, `sessionCleared` to after the next frame's layout and paint following the replay's `done` | `items` |
| `shiki.firstHighlight` | webview, first `getHighlighter` call to ready | `lang`, `theme`, `init` (ms to create the highlighter), the grammar and theme chunks as fetch duration/decoded size; `failed` on error |

`approxChars` is the summed string length (UTF-16 code units) of the replay items, not a serialized size. Runs 1 to 7 took `replay.painted` in the frame callback, before layout and paint, logged the field as `approxBytes`, and timed the fresh panel's start inside `ready` as `ready.initializeEarly`.

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

## Benchmarks

Run from PowerShell; neither needs VS Code:

```
npx vitest bench --run src/extension/pi-session/session-store/__tests__/session-store.bench.ts
npx vitest bench --run src/webview/stores/__tests__/replay-ingest.bench.ts
```

The session-store bench writes real pi JSONL into the hermetic test home: 300 sessions of 5 turns (about 60 KB each) and one 4.6 MB conversation of 400 turns with 20 subagent calls and a compaction at turn 200; 22.4 MB in total. `listPiSessions cold` and `extractPiPromptHistory cold` clear the in-memory metadata cache and delete the persistent one (`~/.damocles/cache/session-meta/`) before every iteration. `listPiSessions new window` clears only the in-memory layer, so it reads the persistent cache as a reloaded or second window does. The replay bench feeds `userReplay`/`assistantReplay` items (two tool calls each, a subagent card every 25 turns) through the real history handlers into fresh Pinia stores, then flushes the streaming store's replay queue as the replay's `done` does.

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
