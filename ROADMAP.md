# System Map ("Compass v2") — Implementation Roadmap

> Status: design-approved, pre-implementation. Self-contained: this file states everything an implementer needs without reading any prior conversation.

---

## 1. Background: the problem this solves

In large codebases, an AI coding agent fails in three recurring ways. The trigger was a developer's observation: _"agents, especially for bigger codebases, cannot ingest all the things, so they will start fixing things locally, and then things explode globally."_

| Failure | Why it happens | Example |
| --- | --- | --- |
| Fixes a bug but misses other places needing the same change | Coupled files often have **no call/import edge**; static analysis can't see the coupling | Add a DB column → migration done, but model/controller/serializer/tests untouched |
| Implements features poorly; ignores invariants | No persistent **architecture model**; rediscovers house rules each session | Posts a webview message from the wrong layer, violating the "seam" rule |
| Re-implements something that already exists | Can't search code **by purpose**, only by name | Writes a new `formatDate` when `toDisplayDate` already exists |

All three share one root cause: the agent has **no persistent, whole-system mental model**. It rebuilds a partial, local picture each session and loses it at every context compaction.

## 2. What already exists in Damocles (the substrate we build on)

**Compass** (`src/extension/compass/`) is a workspace-global **structural** code graph:

- **Storage:** SQLite at `~/.damocles/compass/<sha256(workspacePath).slice(0,12)>/graph.db`. Tables: `nodes` (kind ∈ File/Class/Function/Type/Test; `qualified_name` UNIQUE; `file_path`; FTS5 mirror `nodes_fts`), `edges` (kind ∈ CALLS/IMPORTS_FROM/INHERITS/IMPLEMENTS/CONTAINS/TESTED_BY/DEPENDS_ON/ REFERENCES), and **separate** `communities`, `flows`, `metadata` tables.
- **Worker:** runs in a worker thread (`compass-worker.ts` → `dist/compass-worker.js`, built by `esbuild.config.mjs`). Main thread talks to it via a request/response protocol: the message types (`WorkerResponse{ok,data|error}`, `PostprocessRequest`, `TIMEOUTS`) live in `worker-protocol.ts`, while the transport method `_sendRequest({type,...})` is implemented in `CompassService` (`compass/index.ts`). A `LIGHT_TYPES` set marks read-only requests that interleave with builds; heavy requests (builds) run serially. `worker-core.ts` refuses to drain light requests during a DB transaction.
- **Lifecycle:** `index.ts` watches files (500ms debounce) → `{type:'incrementalUpdate', changedFiles}`. `incremental.ts` (`fullBuild`/`incrementalUpdate`) extracts changed files + their dependents (`findDependents`, 2 hops). `post-process.ts` `runPostProcess` recomputes flows + communities after each build (FTS on demand) — the natural hook point for new derived data.
- **Git:** `git.ts` — exports `getChangedFiles`, `parseGitDiffRanges`, `parseUnifiedDiff`, `resolveRepoRoot` (cached), `SAFE_GIT_REF` (arg-injection guard), `GIT_TIMEOUT` (30s). Internally it uses a module-private `runGit()` (execSync, `GIT_TIMEOUT`, `SAFE_GIT_REF`) and module-private Windows drive-letter reanchoring helpers (`toRepoAbsolute`, `reanchorOnWorkspace`) that are **not exported today**; path helpers `isWithinRoot`/`normalizePath` live in `compass/util.ts`. Phase 0 extracts the reanchoring pair into `util.ts` so co-change can reuse them (see Phase 0).
- **Agent tools:** `pi-session/tools/compass-tools.ts` wraps worker `mcp:*` methods as model-facing pi tools (`CompassSearch`, `CompassQuery`, `CompassBlastRadius`, …) using a `COMPASS_SPECS` array as the single source of truth for names/labels/catalog. All read-only ⇒ allowed in plan mode.
- **Graph view:** `webview/components/CompassGraph.vue` (d3-force) renders `CompassGraphData` (`shared/types/compass.ts`); node shapes + edge styles in `useGraphSymbols.ts`.
- **Enablement:** `damocles.compass.enabled` (default **false**).

**The gap Compass cannot fill:** its clusters are purely structural (Louvain over call/import edges), community descriptions are auto-stubbed (`"Community of N nodes"`), and search is **name-based FTS**. It has no notion of _purpose_ ("what does this do?") or _co-change_ ("what moves together?"). That is the System Map's job.

## 3. The concept

A persistent, workspace-**global** semantic map built as a **layer atop Compass** — reusing its worker, DB, incremental lifecycle, and graph view — adding three lenses. Because the knowledge lives in the **database** (not the conversation), it is always current and **survives compaction**: the agent re-queries it rather than remembering it.

- **Lens B — OUTWARD (co-change).** Mine git history for files that change together but have no call edge → `cochange` records. A tool (`SystemMapExpand`) returns the full touch-point set; a hold-once gate flags skipped coupled files at turn end and triggers one self-correction turn. Fixes "explode globally." **$0, no model.**
- **Lens A — INWARD (capability index).** Generate a one-line _purpose_ per file (per-function for large files) via the existing pi sub-call model; search by purpose. A tool (`SystemMapWhatExists`) answers "does X already exist?" Fixes duplicate implementations.
- **Lens C — DOWNWARD (architecture digest).** A small hybrid (auto-derived + curated) map of systems/responsibilities/invariants, injected per turn near the active edit set. A tool (`SystemMapDigest`) returns the full digest. Fixes weak feature understanding.

## 4. Locked decisions (design to these — do not relitigate)

1. **Scope:** front-load Lens B + the gate as the shippable core; Lens A and C fully specced but sequenced after. All three covered.
2. **Gate = hold-once (not pure advisory).** On `agent_end`, if high-confidence coupled files were skipped, inject a hidden note AND trigger **exactly one** more agent turn so the agent fixes or justifies the gap **before** declaring done. It fires **at most once per user turn** (guarded by `userEntryId`), so it can never loop and never blocks indefinitely. The agent may dismiss with a structured `[skip X: reason]` in its continuation; the gate does not re-fire. (Rationale: a pure advisory arrives _after_ "done" — too late to prevent the missed-spot bug. Hold-once mirrors the existing plan-mode nudge, which is proven safe.)
3. **Enablement:** requires `damocles.compass.enabled`; own sub-toggles under `damocles.compass.systemMap.*` per lens + gate.
4. **Visual panel:** a core phase — render new kinds in `CompassGraph.vue` + a "map around my current change" filter.
5. **No local model / no embeddings infra:** Lens B is pure git math; Lens A/C reuse the existing pi small/fast sub-call model (`runStructuredCompletion`/`hasAuthedSubCallModel`). Search rides FTS + the existing **query-expansion** (synonyms), not vectors.
6. **3 tools** (`SystemMapExpand`, `SystemMapWhatExists`, `SystemMapDigest`) + **2 automatic behaviors** (per-turn injection; the `agent_end` hold-once gate).
7. **Gate-note visibility:** agent-only, hidden from chat (`display:false`).
8. **Expand reach:** BOTH — the agent calls `SystemMapExpand` proactively AND the gate auto-runs the same engine as a safety net.
9. **Capability granularity:** per-file by default; per-function only for large/central ("hot") files. Incremental — only changed files re-summarized.
10. **Capability generation is a DECOUPLED idle background queue** — NOT inline in the structural index. It keeps its own dirty-file set, batches + rate-limits sub-calls, and **pauses while an agent turn is active** so it never competes with the agent's model. First-enable cold start is a rate-limited, resumable backfill.

## 5. Core architectural decision (and why the first draft was wrong)

**Co-change data lives in a NEW dedicated `cochange` table keyed by workspace-relative file paths (the same key space as Compass `nodes.file_path`; see §6) — NOT in the existing `edges` table.** Two reasons this is the correct, non-bandaid choice:

1. **Non-code files must be representable.** Compass only nodes _code_ files (`CODE_EXTENSIONS`). But the highest-value co-change signal involves **non-code files** — `package.json`, DB migrations, `*.yaml`, templates, lockfiles. Keying co-change to `nodes.qualified_name` (as the first draft proposed) would silently **drop every coupling that involves a non-code file**, gutting the feature. A path-keyed table captures any file git reports.
2. **Zero regression to structural queries.** `impact.ts` `computeBlastRadius` and `getEdgesBySources/Targets` read the `edges` table with **no kind filter**. Injecting `CHANGES_WITH` rows there would leak co-change into blast radius, dead-code detection, Louvain community weights, and the graph view — forcing risky edits to every consumer. A separate table touches none of them. This mirrors how `communities` and `flows` are already isolated tables.

Likewise, **capability data lives in a dedicated `capabilities` table** (+ its own `capabilities_fts`), never as a `nodes` kind — so it is immune to the code-symbol FTS triggers, the extraction-format wipe, and node-count stats, and so `removeFileData`/graph queries never touch it.

## 5b. Thread-boundary rule (CRITICAL — model calls are main-thread only)

**The Compass graph DB is owned by the worker thread; the model is reachable only from the main thread.** Verified: `compass-worker.ts` runs in a `worker_threads` worker with a **stubbed** `vscode` module (`worker-vscode-shim.js`), and `PiRuntime.runStructuredCompletion`/`hasAuthedSubCallModel` depend on pi services + the model registry + VS Code SecretStorage — none of which exist in the worker. Therefore:

- **Anything that calls the model runs MAIN-side**, in a new `SystemMapService` (in `compass/`, constructed on the main thread alongside `CompassService`), mirroring how `MemoryService` reaches the sub-call model main-side via `createMemorySubCallRunner()` (whose runner calls `PiRuntime.get().runStructuredCompletion`/`hasAuthedSubCallModel` internally). `SystemMapService` should **reuse that same sub-call runner** rather than hand-rolling `PiRuntime` access. This covers the capability-summary queue (Lens A) and the digest's prose summarization (Lens C).
- **The worker keeps owning all storage/FTS/graph.** Generated rows are sent **into** the worker via a new write-path request (`mcp:systemMap:putCapabilities`) that persists + FTS-indexes them; reads (`whatExists`, graph) stay worker-side. This keeps ONE unified map (so Phase 6 renders capability nodes natively) at the cost of one cross-thread write request, serialized on the worker's heavy path like any other write.
- **Co-change is unaffected:** it is pure `git` + SQL, and the worker already shells `git` — so the miner/recompute runs worker-side in post-process with no model and no boundary issue.

The earlier draft placed capability generation "in post-process" (worker-side) — that was wrong; it could never reach the model. This rule supersedes it.

## 6. Cross-cutting rules (apply to every phase)

- **Co-change scoring is FILE-level and DIRECTIONAL** (not symmetric Jaccard). Keep `A→B` only when: (1) **support** — A,B co-occur in ≥ `minSupport` commits (default 3); (2) **confidence** — `P(B|A)=co(A,B)/total(A) ≥ minConfidence` (default 0.5); (3) **idf** — down-weight B by how many distinct files it co-changes with, `idf = log(totalFiles / distinctPartners(B))`, final score `= confidence * idf`. This is asymmetric on purpose: `P(tool-names | a tool file)` is high (warn), the reverse is low (don't warn), and lockfiles that "change with everything" score ~0.
- **Commit-hygiene defense (locked decision; industry standard — code-maat/CodeScene both do this).** **Skip commits touching > `maxCommitFiles` files (default 50)** — sweeping "misc"/format/rename commits are noise, not coupling. Combined with the `minSupport ≥ 3` recurrence floor, a single mega-commit can never mint an edge. `maxCommitFiles` is configurable.
- **Thin-history self-suppression (locked decision).** If the in-scope mined commit count is below a floor (`coChange.minHistory`, default 20), co-change is **not trusted**: the gate and injection treat it as having no data (Compass structural blast-radius still works), and the status surfaces a quiet "not enough git history yet." It turns on automatically as history accrues. This prevents the gate nagging about coincidental couplings on a young repo (the precise "gate fatigue" failure).
- **Path keys must match Compass's `nodes.file_path` convention exactly** (workspace-anchored, forward-slashed, via `normalizePath`). `git log --name-only` emits **repo-root-relative** paths; resolve each to absolute against the repo root then re-anchor onto the workspace (`toRepoAbsolute` → `isWithinRoot` → `reanchorOnWorkspace` → `normalizePath`), the same sequence `getChangedFiles` in `git.ts` applies. `isWithinRoot` and `normalizePath` are already exported from `compass/util.ts`; `toRepoAbsolute`/`reanchorOnWorkspace` are module-private in `git.ts` today, so Phase 0 extracts them into `util.ts` first (one authoritative home for re-anchoring) and `co-change.ts` imports the full trio + `normalizePath` from `util.ts`. Co-change keys, the Compass `file_path` join (Phase 3 gate, Phase 6 graph), and the checkpoint diff must all live in the same key space or the joins silently return nothing.
- **Mining is PROJECT-SCOPED (locked decision).** When the workspace is a subdirectory of the repo (monorepo package), mine only the workspace subtree: `git log --name-only -M --no-merges -n <limit> -- <workspaceRoot>`. This keys everything in workspace space, matches Compass and the checkpoint diff, and avoids cross-package noise. (The common case — workspace IS the repo root — is just the degenerate form of this and needs no special handling. Cross-package couplings are explicitly out of scope; revisit only if multi-package work becomes common.) `-M` enables rename detection; a file's history across a rename may split (minor, accepted) — note it in code.
- **Migrations:** bump **`CURRENT_SCHEMA_VERSION`** (additive, preserves data) for new tables. **Never** bump the **extraction-format** version (it wipes + re-extracts) — co-change/capabilities change nothing about parsing.
- **Worker transaction safety:** read tools are LIGHT; all recompute runs in the heavy build/ post-process path; honor `yieldFn`; never drain light during a transaction (existing guard).
- **Fail-soft everywhere:** empty/shallow git history → no edges, no error. Git binary missing or `runGit` throws → caught, feature inert. No authed sub-call model → capability/digest generation is a silent no-op that retains prior rows (`hasAuthedSubCallModel()` guard). Compass not ready → tools return a clean "not available yet" message, never throw (mirror `buildCompassContext`'s try/catch).
- **"Files edited this turn"** = the **checkpoint staged diff**, not Edit-tool message scanning. The checkpoint system stages the work tree and diffs against the turn's `beforeCommit` (`checkpoints/repo-manager.ts` `diffAgainst` → `--numstat`; driven by `auto-checkpoint.ts` `turnStart`/`finalizeRun`). This captures files changed by **any** means (Edit, Write, shell, codegen). **Caveat (verified):** `finalizeRun` returns the diff in its checkpoint entry, but the hold path _defers_ finalize — so for the **held** turn the diff isn't produced when the gate needs it. The gate must therefore **peek** the staged diff (stage-all + `diffAgainst(beforeCommit)`, **no commit**) via a new read-only `CheckpointService` method, rather than relying on the finalize return value. See Phase 3.
- **Model-call cadence (capabilities).** The file watcher debounces 500ms and **batches** all changed paths into one `incrementalUpdate`, and unchanged-hash files are skipped — so the model is **never** called per keystroke and a multi-file save/agent-edit becomes **one** batched pass. But capability generation does **not** run inline in that pass (decision 10): it runs on a **separate idle queue** that (a) marks changed files dirty, (b) waits for an idle gap, (c) **pauses while an agent turn is active** (poll `session.isStreaming` / `adapter.observedAgentRun()`), and (d) batches sub-calls (5 at a time, ~3s apart, stop after repeated failures). Net: smooth, rate-limited cost; zero contention with the agent's own model; zero calls when nothing changed.
- **Co-change never calls the model and refreshes on COMMITS, not saves.** Co-change derives from `git log`; editing/saving changes nothing until a commit. So co-change recompute is gated on a HEAD/commit-count delta (a cheap `metadata` comparison), not on file-save. $0, no model, ever.
- **Data boundary (capabilities).** Lens A sends source snippets to the **configured sub-call model** — the _same_ model and trust boundary memory already uses for extraction/rerank; **no new external boundary is introduced.** Because `capabilityIndex` is its own toggle (default **off**), enabling it is an informed opt-in. This must be stated plainly in the docs (Phase 7). A local-model option was considered and deliberately scoped out (it contradicts decision 5 and adds config complexity); the toggle + documentation is the chosen control. Co-change and the digest's structural skeleton are derived locally; only Lens A summaries and Lens C's optional prose summarization use the model.

## 7. Non-goals

- No indefinitely-blocking gate. The gate holds for **exactly one** self-correction turn, then the turn settles regardless; it can never trap the agent in a loop or block completion permanently.
- No local model, embeddings server, or vector DB. (Lens A reuses the existing sub-call model; a local-model option was considered and deliberately scoped out — toggle + docs is the privacy control.)
- No new persistence stack outside the Compass SQLite DB.
- No standalone webview panel (new kinds render inside `CompassGraph.vue`).
- System Map is inert unless Compass is enabled.

---

## Phase 0 — Git co-change miner (standalone, no agent surface)

**Goal:** Prove the signal is real and directional+idf scoring suppresses noise, before any persistence or wiring. Pure function, $0, no model. **Owner:** Backend Architect.

**Context the owner needs:** `git.ts` plumbing conventions (module-private `runGit` execSync `GIT_TIMEOUT` 30s, `SAFE_GIT_REF`, `resolveRepoRoot` cache, and the module-private Windows reanchoring helpers `toRepoAbsolute`/`reanchorOnWorkspace`); `compass/util.ts` (exports `isWithinRoot`/`normalizePath`, the destination for the extracted reanchoring pair); the scoring spec in §6; vitest layout (`__tests__/`). No knowledge of the rest of the roadmap required.

### Work items & acceptance criteria

1. **Prerequisite — one authoritative home for path re-anchoring.** Move the module-private `toRepoAbsolute` and `reanchorOnWorkspace` out of `git.ts` into `compass/util.ts`, next to the existing `isWithinRoot`/`normalizePath`, and have `git.ts` import them back so `getChangedFiles` keeps its current behavior. This avoids duplicating the helpers in `co-change.ts` (which would risk the #1 documented risk — key-space drift). `co-change.ts` then imports the full trio (`toRepoAbsolute`, `reanchorOnWorkspace`, `isWithinRoot`) + `normalizePath` from `util.ts`.
   - **AC:** `getChangedFiles` output is unchanged (existing git tests pass); `toRepoAbsolute`/`reanchorOnWorkspace` are exported from `util.ts` and no longer defined in `git.ts`.
2. New `src/extension/compass/co-change.ts`: `mineCoChange(workspaceRoot, {historyLimit, maxCommitFiles})` shells `git log --name-only -M --no-merges --pretty=format:%H -n <historyLimit> -- <workspaceRoot>` (project-scoped — locked decision), parses into per-commit file-sets, **skips commits touching more than `maxCommitFiles` files (default 50)**, re-anchors each path onto the workspace (`toRepoAbsolute`→`isWithinRoot`→`reanchorOnWorkspace`→`normalizePath`, all imported from `util.ts`) so keys match Compass `file_path`, drops path-escaping files. Returns the kept records **plus the in-scope commit count**.
   - **AC:** Against a fixed `git log` fixture, returns one record per kept commit in workspace-key space; merge commits and >`maxCommitFiles` commits excluded; a subdirectory workspace yields only in-subtree paths; an empty repo / shallow clone / missing-git returns `{records:[], commits:0}` (no throw).
3. Compute `total(A)`, `co(A,B)`, `distinctPartners(B)`.
   - **AC:** Counts match a hand-computed 3-commit fixture with known overlaps.
4. Emit directional records `{source, target, support, confidence, idf, score, lastSeen}` passing all three gates.
   - **AC:** A synthetic "lockfile in every commit" file yields **no** inbound high-confidence records and is down-weighted below threshold; a registration cluster (e.g. `tool-names.ts` ⇄ a tool file) shows the directional asymmetry (high one way, low the other).
5. Thresholds are parameters with defaults (`minSupport=3`, `minConfidence=0.5`, `historyLimit=1000`, `maxCommitFiles=50`, `minHistory=20`). The miner reports the in-scope commit count so callers can apply the `minHistory` self-suppression floor.
   - **AC:** Changing a threshold deterministically changes the kept set; below `minHistory` commits, the caller can detect "thin history" from the returned count.

### Files

- `src/extension/compass/util.ts` (add `toRepoAbsolute`/`reanchorOnWorkspace`), `src/extension/compass/git.ts` (import them back), `src/extension/compass/co-change.ts` (new); `src/extension/compass/__tests__/co-change.test.ts` (new).

### Verification

- `npm run typecheck` — compiles. `npx vitest run src/extension/compass/__tests__/co-change.test.ts` — scoring on fixtures. `npm run lint`.
- **Proves:** the novel signal exists and scoring kills high-frequency-file noise — the central risk — with zero DB/agent risk. **Run against the IEMIS Laravel repo and eyeball the top pairs before Phase 1.**

---

## Phase 1 — Persist co-change in a dedicated table + recompute in post-process

**Goal:** Land co-change in the DB (its own table), recomputed each build, incrementally safe, behind a schema migration. No agent surface yet. **Owner:** Database Optimizer (lead) + Backend Architect.

**Context the owner needs:** §5 (why a separate table), §6 (migrations/transaction rules); `schema.ts` (`communities`/`flows` are the template for an isolated table), `migrations.ts` (`CURRENT_SCHEMA_VERSION`, transaction-wrapped version blocks, the existing `[Compass] Schema migration vN` log style), `database.ts` `GraphStore` (`execRaw`/`queryRaw`, `getAllFiles`, `serialize` dirty-check), `post-process.ts` `runPostProcess`, `compass-worker.ts` build paths, `worker-protocol.ts` `PostprocessRequest`.

### Work items & acceptance criteria

1. Schema migration: add a `cochange` table — `{ source_path TEXT, target_path TEXT, support INTEGER, confidence REAL, idf REAL, score REAL, last_seen INTEGER, PRIMARY KEY(source_path, target_path) }` + index on `source_path` and on `score`. Add a `file_change_stats` table `{ file_path TEXT PRIMARY KEY, total_changes INTEGER, distinct_partners INTEGER, updated_at INTEGER }` to cache idf inputs. Bump `CURRENT_SCHEMA_VERSION` (additive; **not** extraction-format). Add `GraphStore` methods: `replaceCoChange(records)`, `getCoChangeBySources(paths[])`, `getCoChangeTargetsAbove(paths[], minConfidence)`, `getAllCoChange()`.
   - **AC:** Opening an old DB upgrades without wiping `nodes`/`edges`; fresh DB installs the new version; re-running is idempotent (`IF NOT EXISTS`). The structural `edges` table is untouched — a regression test asserts `computeBlastRadius` output is byte-identical before/after the migration on a fixture graph.
2. `src/extension/compass/co-change-store.ts`: `recomputeCoChange(store, workspaceRoot, opts)` calls `mineCoChange`, then `store.replaceCoChange(records)` (full delete+insert in one transaction), and persists the in-scope commit count to `metadata` (key `cochange_commit_count`) so the gate/injection can apply the `minHistory` thin-history floor. Expose `getCoChangeCommitCount()` on `GraphStore`.
   - **AC:** After a build, `getAllCoChange()` returns directional records and `getCoChangeCommitCount()` returns the mined count; re-running produces no duplicates; a source file deleted from the repo leaves no stale records; a repo below `minHistory` commits reports its true (low) count so callers suppress.
3. Wire into `runPostProcess` behind a `coChange?: boolean` flag; call with `coChange:true` from the worker's full-build, incremental, and `postprocess` paths; add `coChange` to `PostprocessRequest`.
   - **AC:** Full + incremental builds both refresh co-change inside the heavy path (no light-read race); `yieldFn` honored; latency within `TIMEOUTS.incrementalUpdate` (120s) on a large repo.
4. Incremental efficiency: gate a full re-mine behind a commit-delta/staleness check (compare HEAD/ commit count to the last mined value in `metadata`); otherwise reuse cached `file_change_stats`.
   - **AC:** A no-op incremental build (no new commits) does not re-shell full `git log`.

### Files

- `migrations.ts`, `schema.ts`, `database.ts`, `co-change-store.ts` (new), `post-process.ts`, `compass-worker.ts`, `worker-protocol.ts`; `__tests__/migrations.test.ts`, `__tests__/co-change-store.test.ts`, plus a `computeBlastRadius` no-regression test.

### Verification

- `npm run typecheck`; `npx vitest run` (migrations + co-change-store + blast-radius no-regression); `npm run build` (confirms `dist/compass-worker.js` bundles with externals intact).
- **Proves:** co-change persisted in isolation, incrementally safe, with the structural graph provably unaffected.

---

## Phase 2 — `SystemMapExpand` tool (Lens B agent surface)

**Goal:** Given a seed change set, return the fused touch-point set (Compass blast radius ∪ high-confidence co-change) as a checklist. Read-only, plan-mode safe. **Owner:** Backend Architect.

**Context the owner needs:** the full tool-registration ritual (below), `impact.ts` `computeBlastRadius`, the Phase 1 `GraphStore` co-change methods, `worker-protocol.ts` + `dispatch()`

- `LIGHT_TYPES`, the `compass-tools.ts` `COMPASS_SPECS` pattern, `GATEABLE_MODULE_NAMES` (defined in `tools/tool-catalog.ts`, consumed by `permission-gate.ts`'s `runPermissionGate`), `buildCompassSection` (private fn in `pi-session/system-prompt.ts`, called by `buildSystemPrompt` gated on `compassEnabled`).

### The shared expansion engine

Create `src/extension/compass/system-map/expand.ts` — `expandTouchPoints(store, {files, maxDepth, minConfidence})` returns `{ structural: [...], coChangeOnly: [...] }` where `structural` is `computeBlastRadius` output and `coChangeOnly` is high-confidence co-change targets that are **not** already in the structural set (the spots with no call edge). Because `computeBlastRadius` operates on **graph nodes** while co-change is keyed by **file path**, the engine resolves each seed file path to its Compass `File`/symbol node(s) for the structural query, while using the raw workspace-relative paths for the co-change lookup — the same path→node mapping Phase 6 applies for the graph view. **Phase 3's gate reuses this exact function** (decision 8) — single engine, two callers.

### Work items & acceptance criteria

1. Worker handler `mcp:systemMap:expand` (`worker-protocol.ts` request type + union + `mcpRead` timeout; `dispatch()` case; add to `LIGHT_TYPES`). Calls `expandTouchPoints`; formats text output with structural hits and a distinct **"changes-with (no structural link)"** section, each line showing confidence.
   - **AC:** A seed with both callers and a co-change-only partner lists the partner under the distinct heading with its confidence; below-threshold partners omitted; unknown file → empty, no throw.
2. `CompassService.mcpSystemMapExpand(input)` via `_sendRequest` (LIGHT).
   - **AC:** Returns worker text; routed light (no heavy-queue wait).
3. `TOOL_SYSTEMMAP_EXPAND` (+ two placeholders) in `shared/tool-names.ts`.
4. New `pi-session/tools/system-map-tools.ts` mirroring `compass-tools.ts`: a `SYSTEM_MAP_SPECS` array as source of truth (mirroring `COMPASS_SPECS`), `NAME_BY_KEY`, `SYSTEM_MAP_PI_TOOL_NAMES`, `SYSTEM_MAP_TOOL_CATALOG` (group `'compass'`), `buildSystemMapPiTools(deps)` with `pi.defineTool` → `textResult(...)`; each `ensureInitialized()` first.
   - **AC:** Builds; a new schema-parity test in the style of `mcp-schema-parity.test.ts` asserts `SYSTEM_MAP_SPECS` is the single source of truth for names/catalog.
5. Register in `tools/index.ts` `buildCustomTools` inside the existing `if (compassService)` block; add names to `moduleToolNames` gated on `isSystemMapEnabled` (Phase 7; until then `isEnabled`); spread catalog into `FULL_TOOL_CATALOG`; add names to the `GATEABLE_MODULE_NAMES` set in `tool-catalog.ts` (which already spreads `...COMPASS_PI_TOOL_NAMES` etc.). In `runPermissionGate`, the `GATEABLE_MODULE_NAMES` branch runs **before** the plan-mode write/shell block, so in-process module tools listed there auto-allow (skip the approval modal) and remain available in plan mode — the reason the new System Map tools must join that set.
   - **AC:** `tool-catalog.test.ts` passes; because the tool names are in `GATEABLE_MODULE_NAMES`, `runPermissionGate` auto-allows them in plan mode (no permission prompt).
6. System-prompt guidance: define a new `SYSTEM_MAP_SYSTEM_PROMPT` constant in `compass/system-prompt.ts` (for cohesion with `COMPASS_SYSTEM_PROMPT`), consumed by `buildCompassSection` in `pi-session/system-prompt.ts` when System Map is enabled — instructs **"call `SystemMapExpand` BEFORE finishing a multi-file change."**
   - **AC:** Present when enabled, absent when disabled.

### Files

- `worker-protocol.ts`, `compass-worker.ts`, `compass/index.ts`, `compass/system-map/expand.ts` (new), `shared/tool-names.ts`, `tools/system-map-tools.ts` (new), `tools/index.ts`, `tools/tool-catalog.ts`, `compass/system-prompt.ts`, `pi-session/system-prompt.ts`; `__tests__/`.

### Verification

- `npm run typecheck`; `npx vitest run` (tool-catalog + system-map tool parity + expand engine); `npm run lint`; `npm run build`.
- **Proves:** the agent can fetch the fused touch-point set; plan-mode safe; catalog/gate invariants hold.

---

## Phase 3 — Hold-once completeness gate on `agent_end`

**Goal:** At turn end, detect high-confidence co-changed files the agent edited-around-but-skipped, inject a hidden note, and trigger **exactly one** more agent turn so it fixes or justifies the gap **before** declaring done. Fires at most once per user turn; never loops, never blocks indefinitely. **Owner:** Backend Architect.

**Context the owner needs (all verified against the code):**

- The chain: `damocles-extension.ts` `pi.on('agent_end')` → `panel.onAgentEnd` → `PiSession.onParentAgentEnd` in `pi-session.ts`, which runs `tryBackgroundKeepAlive` then `tryPlanModeHold`.
- **The exact hold pattern to copy** (from `tryPlanModeHold`, the inject-and-hold block using `PLAN_MODE_NUDGE_CUSTOM_TYPE`): `await session.sendCustomMessage({customType, content, display:false}, {deliverAs:"followUp", triggerTurn:true})`, then `this.checkpointService?.deferNextFinalize()` and `this.adapter.holdNextAgentEnd()`.
- **The loop-prevention mechanism (verified):** `adapter.holdNextAgentEnd()` sets a **one-shot boolean** `_holdNextAgentEnd` in `pi-stream-adapter.ts`; the `agent_end` handler consumes it once (`if (_holdNextAgentEnd) { _holdNextAgentEnd=false }`) and the **next** `agent_end` settles normally. So one injection = exactly one extra turn. The gate adds a second guard: a per-`userEntryId` "already fired" flag so it never fires twice for the same user turn even across sub-turns.
- **Edited-files source (verified caveat):** the per-turn diff is produced inside `auto-checkpoint.ts` `finalizeRun` (`stageAll` + `diffAgainst(beforeCommit)` → `parseDiffStats`). It is **not** discarded in general (`finalizeRun` returns it in the checkpoint entry) — but the hold path **defers** finalize (`CheckpointService.deferNextFinalize`, consumed in its `onAgentEnd` guard), so for a **held** turn the diff isn't produced when the gate needs it. So the gate must **peek**, not finalize: add a read-only `CheckpointService.peekChangedFiles()` that stages and runs `diffAgainst(pending.beforeCommit)` **without committing**, returning the file list. Fallback: scan `event.messages` for `Edit`/`Write` results if no pending checkpoint.

### Key decision: hold-once, ordered LAST, idempotent per turn

The gate composes **after** `tryBackgroundKeepAlive` and `tryPlanModeHold` and is **skipped if either already held** (only one continuation mechanism fires per `agent_end`). It injects-and-holds using the exact pattern above, guarded so it fires at most once per `userEntryId`. The agent's continuation may address the files or emit a structured `[skip <file>: reason]`; on the next `agent_end` the gate sees its per-turn flag set and stays silent, so the turn settles. This is strictly safer than an unbounded loop and strictly more useful than a post-hoc advisory.

### Work items & acceptance criteria

1. `CheckpointService.peekChangedFiles(): Promise<string[]>` — stage + `diffAgainst(beforeCommit)` + `parseDiffStats`, **no commit**, paths re-anchored to the workspace key space (so they match the `cochange` keys); returns `[]` when no pending turn or repo unavailable (fail-soft, never throws).
   - **AC:** After a turn that edited X,Y (by any tool incl. shell), returns {X,Y} without creating a checkpoint commit; read-only turn returns ∅; missing repo returns ∅ silently.
2. New `tryCompletenessGate(event)` in `pi-session.ts`, called from `onParentAgentEnd` after the other two; returns early if a hold is active, if `gate.enabled` is false, if Compass not ready, **if co-change is thin-history-suppressed (in-scope commits < `minHistory`)**, or if the per-`userEntryId` flag is already set. Otherwise: `editedSet = peekChangedFiles()`; run the Phase 2 `expandTouchPoints({files: editedSet, minConfidence})`; `missed = coChangeOnly − editedSet`; if `missed` non-empty, set the per-turn flag, inject `{customType: SYSTEM_MAP_COMPLETENESS_CUSTOM_TYPE, content: <names+confidence+how-to-skip>, display:false}` with `{deliverAs:"followUp", triggerTurn:true}`, then `deferNextFinalize()` + `holdNextAgentEnd()`; return `true`.
   - **AC:** A skipped high-confidence partner triggers exactly one continuation turn with the hidden note; the agent fixing or `[skip …]`-ing it lets the next `agent_end` settle (no second fire); no `missed` ⇒ no hold, turn settles immediately; inert when disabled/not-ready.
   - **AC (loop safety):** a test simulating an agent that ignores the note asserts the gate fires once and the turn then completes (the per-turn flag + one-shot `_holdNextAgentEnd` both verified).
3. Webview visibility: emit the note with `display:false` (exactly as the plan-mode inject-and-hold and the `CONTEXT_INJECTION_CUSTOM_TYPE` context injection do). No suppression registration exists or is needed — `pi-stream-adapter.ts`'s `message_start` handler starts a visible bubble **only** for `role === 'assistant'`, so any non-assistant `display:false` custom message is already never rendered (decision 7).
   - **AC:** The note does not appear in the user transcript.

### Files

- `pi-session.ts` (`tryCompletenessGate`, call site, per-turn flag, `SYSTEM_MAP_COMPLETENESS_CUSTOM_TYPE` constant), `checkpoint-service.ts` (`peekChangedFiles`), `compass/system-map/expand.ts` (reused); `__tests__/pi-session.test.ts` (fires-once + holds-one-turn + settles-after + skip-when-other-hold-active + ignored-note-still-settles), `checkpoints/__tests__/` for `peekChangedFiles`.

### Verification

- `npm run typecheck`; `npx vitest run src/extension/pi-session/__tests__/pi-session.test.ts` `src/extension/pi-session/checkpoints/__tests__/`; `npm run lint`.
- **Proves:** the gate catches missed coupled files **before** "done", triggers exactly one continuation, can never loop or block indefinitely, and never creates a spurious checkpoint commit.

---

## Phase 4 — Lens A: capability index (decoupled queue) + `SystemMapWhatExists`

**Goal:** Per-file (per-function for hot files) purpose summaries generated **main-side** by the existing sub-call model on a **decoupled idle queue** that pauses during agent turns, persisted into the worker DB, searchable by purpose. **Owner:** Backend Architect (queue/sub-call) + Database Optimizer (table/FTS).

**Context the owner needs:** §5 (separate `capabilities` table, not a node kind), **§5b (model calls are MAIN-side; rows written into the worker via a request)**, decision 10 (the queue); `subcall-runner.ts` (`createMemorySubCallRunner().run`, `runStructuredCompletion`, `hasAuthedSubCallModel`, fail-soft, 12s rerank / 45s extract timeouts); `query-expansion.ts` (`expandQuery`/`expandMemoryTerms` synonym expansion, so "search by meaning" is real, not keyword match); **the consolidation/idle pattern (verified)** in `memory/index.ts` — `armIdleTimer()` (`damocles.memory.autoExtract.idleSeconds` default 180), the `consolidating` / `consolidationInFlight` / `pendingConsolidation` serialization, and `startBackfill()` (batch 5, 3s delay, stop after 3 consecutive failures, `AbortController`); **the "turn active" signals (verified)** — `session.isStreaming` and `adapter.observedAgentRun()` in `pi-stream-adapter.ts`; `schema.ts` FTS5 triggers.

### Why a decoupled MAIN-SIDE queue (decisions 10 + §5b)

Capability summaries derive from **file content**, so they must refresh on edits — but (a) the model is only reachable main-side (§5b), and (b) running it **inline** in the structural index would fire mid-turn while the agent edits, competing for the small-fast model. So generation lives in a main-thread `SystemMapService` queue (modeled on memory consolidation): the worker marks changed files dirty and reports them; the main-side queue debounces to an idle gap → **pauses while a turn is active** → batches sub-calls → sends finished rows back to the worker to persist + FTS-index. The worker never calls the model; the main thread never owns the graph DB.

### Work items & acceptance criteria

1. Migration (worker-side): `capabilities` table `{ id, scope_kind('file'|'function'), qualified_name UNIQUE, purpose_summary, search_terms, file_path, source_hash, updated_at }` + `capabilities_fts` (porter/unicode61, content-linked) + triggers + a `capability_dirty` table. Bump `CURRENT_SCHEMA_VERSION`. **Orphan pruning:** delete rows whose `file_path` is absent from `nodes`.
   - **AC:** Upgrade adds tables without touching `nodes`/`edges`; idempotent; removed-file rows pruned.
2. Dirty-marking (worker-side): in the incremental build path, record changed files into `capability_dirty` (cheap, no model). Add a worker read `mcp:systemMap:dirtyFiles` returning the pending set, and a worker write `mcp:systemMap:putCapabilities` that upserts generated rows + indexes FTS + clears their dirty flags. This is the ONLY capability work the worker does.
   - **AC:** A multi-file incremental build marks all changed files dirty in one pass; unchanged-hash files are not marked; `putCapabilities` upsert is idempotent and clears dirty flags.
3. Main-side `compass/system-map-service.ts` (`SystemMapService`, constructed beside `CompassService`): an idle-driven queue that (a) arms a debounce timer when the worker reports new dirty files (or on a periodic poll); (b) before each batch checks the turn-active signal and **re-arms instead of running** if `session.isStreaming` / `observedAgentRun()` indicates a live turn; (c) pulls the dirty set via `compassService.mcpSystemMapDirtyFiles()`, reads those files' nodes, and for each asks the sub-call runner for `{purpose, searchTerms}` (per-file; per-function only above a size/centrality threshold — decision 9); (d) expands `searchTerms` via `query-expansion`; (e) sends results back via `compassService.mcpSystemMapPutCapabilities(rows)`; (f) batches of 5 with ~3s gaps; (g) serializes like consolidation (single in-flight + pending coalesce); (h) fail-soft when `hasAuthedSubCallModel()` is false (no-op; rows stay dirty for later).
   - **AC:** With a stubbed runner, dirty files get rows during idle; with `no-model`, no throw and files stay dirty; **a test asserts no sub-call is issued while the turn-active signal is true**; unchanged `source_hash` ⇒ zero sub-calls; the worker is the sole writer of the `capabilities` table (main side only sends rows).
4. Cold-start backfill (first enable on an existing repo): a resumable `startCapabilityBackfill()` on `SystemMapService` modeled on `memory/index.ts startBackfill` — drains the worker's dirty set (the migration seeds every file as dirty on first install) in batches of 5, ~3s apart, abortable, stop after 3 consecutive failures, resume on restart. Search returns partial results while it fills.
   - **AC:** On first enable, capabilities accrue in the background without a cost spike; aborting (dispose) stops cleanly; restart resumes where it left off; `SystemMapWhatExists` returns partial results mid-backfill.
5. Worker + proxy + tool: `mcp:systemMap:whatExists {query, limit?, detail_level?}` (LIGHT) runs the query through `expandQuery` then matches `capabilities_fts`; `mcpSystemMapWhatExists`; `SystemMapWhatExists` in `SYSTEM_MAP_SPECS`.
   - **AC:** "validate auth tokens" returns hits with file paths even when the symbol name shares no tokens with the query (synonym/FTS path, fixture-proven); empty result returns a clean "no existing capability found — safe to implement."
6. System prompt: extend guidance — **"call `SystemMapWhatExists` BEFORE writing new code."**
   - **AC:** Present when enabled.

### Files

- Worker-side: `migrations.ts`, `schema.ts`, `database.ts` (capability CRUD + dirty set + FTS query), `incremental.ts` (dirty-marking only), `compass-worker.ts` + `worker-protocol.ts` (`mcp:systemMap:dirtyFiles` read + `mcp:systemMap:putCapabilities` write + `whatExists`).
- Main-side: `compass/system-map-service.ts` (new — the model queue + backfill), `compass/index.ts` (`SystemMapService` construction + proxy methods + turn-active signal wiring), `tools/system-map-tools.ts`, `compass/system-prompt.ts`; `__tests__/`.

### Verification

- `npm run typecheck`; `npx vitest run` (`SystemMapService` queue with stubbed runner: idle-batch, pause-during-turn, no-model no-op, resumable backfill; worker `putCapabilities`/`whatExists` handlers; whatExists synonym-match fixture); `npm run build`.
- **Proves:** summaries generate **main-side** on idle without competing with the agent, persist into the worker DB via the write path, cost is smooth and rate-limited, fail-soft with no model, and purpose search returns name-independent hits.

---

## Phase 5 — Lens C: architecture digest + per-turn injection

**Goal:** A small hybrid (auto + curated) system map injected each turn near the active edit set — survives compaction. **Owner:** Backend Architect.

**Context the owner needs:** §5b (model calls are MAIN-side; the digest's auto-summarization runs in `SystemMapService` and writes rows into the worker, exactly like Lens A); `agent-start.ts` `buildAgentStartResult` joins `dynamicParts = [memory context, buildCompassContext]` into a `display:false` custom message at **turn start** (so it's in the transcript and pi's compaction preserves it); `memory/injection-database.ts` (per-(sessionId, promptIndex) persistence, independent of compaction); `impact.ts` for hop expansion; the sub-call runner; the curation source decision below.

### Work items & acceptance criteria

1. Storage + curation: a worker-side `systems` table `{ name, responsibility, key_files (JSON), invariants (JSON), is_curated INTEGER }`. The **structural skeleton** (communities + co-change clusters + key files) is derived **worker-side** (no model); the **prose summarization** runs **main-side** in `SystemMapService` (model) and is written back via a worker request, same boundary as Lens A (§5b). Seed curated invariants from a **`.damocles/system-map.md`** file (version- controlled, human-editable, read main-side). Re-derivation refreshes only non-curated fields.
   - **AC:** Digest persists across sessions; re-derivation never clobbers curated invariants; editing `.damocles/system-map.md` updates the curated set on next build; with no sub-call model the skeleton + curated file still populate (only the auto-prose is skipped, fail-soft).
2. `buildSystemMapContext(panel)` in `agent-start.ts`, added to `dynamicParts` alongside `buildCompassContext`. Assembles (a) the small global digest; (b) capabilities + co-change for files within 1–2 Compass hops of the active edit set (active editor file + the turn's edited set). Distance-filtered, with a hard token budget (mirror the config-driven caps in `getCatalogLimits`, a module-private fn in `memory/managers/injection-manager.ts` that returns catalog caps including a `pinnedTokenBudget`).
   - **AC:** Injected block stays under a documented token budget; only near-edit-set entries appear; returns `''` when System Map disabled or Compass not ready.
3. Persistence: record per `(sessionId, promptIndex)` via the injection-database pattern; the block rides the existing `CONTEXT_INJECTION_CUSTOM_TYPE` `display:false` custom message, so it is never rendered as a chat bubble (non-assistant + `display:false`, no registration needed).
   - **AC:** Metadata persisted; no new chat bubble; the injected note is present in the transcript after a compaction (survives via the custom message).
4. `SystemMapDigest` tool: third tool, on-demand full-digest retrieval (`mcp:systemMap:digest`); read-only, plan-mode safe; registered in `SYSTEM_MAP_SPECS`/catalog/gateable.
   - **AC:** Returns the full digest text; plan-mode safe.

### Files

- `agent-start.ts`, `compass/system-map/digest.ts` (new), `migrations.ts`/`schema.ts`/`database.ts` (`systems` table), `compass-worker.ts`, `worker-protocol.ts`, `compass/index.ts`, `tools/system-map-tools.ts`, `compass/system-prompt.ts`, `memory/injection-database.ts` (reuse); `__tests__/`.

### Verification

- `npm run typecheck`; `npx vitest run` (`buildSystemMapContext` budget/distance + digest tool + curation-sticky test); `npm run lint`; `npm run build`.
- **Proves:** the digest + near-edit context injects within budget every turn, survives compaction, curated invariants are sticky, and the on-demand tool works.

---

## Phase 6 — Visual panel: new kinds in `CompassGraph.vue` + "map around my change"

**Goal:** Render co-change, capability, and architecture nodes/edges in the existing graph, with a structural-vs-system-map toggle and a change-seeded filter. **Owner:** Frontend Developer (lead) + Backend Architect (graph worker query).

**Context the owner needs:** `shared/types/compass.ts` (`CompassNodeKind`, `CompassEdgeKind`, `CompassGraphData/Node/Edge`); `useGraphSymbols.ts` (`NODE_SHAPE`, `EDGE_STYLE` — `Record<>` totality forces exhaustiveness); `CompassGraph.vue` d3-force render; `useCompassStore.requestGraph()` → `compassRequestGraph` (`messages.ts`) → `compass-handlers.ts` → `webviewGraph` → worker `webview:graph` (`handleWebviewGraph`). **Design note:** co-change is path-keyed; to render it as graph nodes, map each file path to its `File` node (or synthesize a lightweight file node for non-code files that have no `nodes` row — render those with a neutral "file" shape so non-code couplings are visible).

### Work items & acceptance criteria

1. Types: add `'Capability'` to `CompassNodeKind` and `'CHANGES_WITH'` (+ any architecture/system edge) to `CompassEdgeKind` in `shared/types/compass.ts`.
   - **AC:** `useGraphSymbols`, store, handlers compile against the widened unions.
2. Symbols/styles: add a `Capability` shape to `NODE_SHAPE` and a distinct dashed `CHANGES_WITH` entry to `EDGE_STYLE`; update the legend (`CompassHelpDialog.vue`, `CompassEdgeFilterPopover.vue`).
   - **AC:** Style maps are total over the new unions (compiler-enforced); legend shows new kinds.
3. Worker graph query: extend `webview:graph` (`handleWebviewGraph`) with a mode/filter param to return system-map kinds and a subgraph seeded by changed files (`computeBlastRadius` + co-change targets, mapping paths→nodes / synthetic file nodes). Thread the param through `webviewGraph` proxy, `compass-handlers.ts`, `messages.ts`, `useCompassStore.requestGraph`.
   - **AC:** System-map mode returns capability/co-change kinds incl. non-code file nodes; "map around my change" returns only nodes within N hops of the seed files.
4. UI: a graph-mode toggle (structural vs system-map) + a "map around my current change" control seeded from the active edit set, in `CompassGraph.vue`.
   - **AC:** Toggling re-requests/re-renders; the filter narrows to the change neighborhood; the existing structural view is unchanged when the toggle is off.

### Files

- `shared/types/compass.ts`, `shared/types/messages.ts`, `useGraphSymbols.ts`, `CompassGraph.vue`, `CompassHelpDialog.vue`, `CompassEdgeFilterPopover.vue`, `useCompassStore.ts`, `chat-panel/message-router/handlers/compass-handlers.ts`, `compass/index.ts` (`webviewGraph` signature), `compass-worker.ts` (`handleWebviewGraph`), `worker-protocol.ts`; `__tests__/`.

### Verification

- `npm run typecheck` (exhaustive `Record` maps catch any missed kind); `npx vitest run` (store/handler); webview build via `npm run build`; `npm run lint`. **Manual UI check:** open the graph, toggle system-map mode, confirm co-change edges (incl. a non-code file) render and the change-scoped filter narrows the view.
- **Proves:** new kinds render with distinct styles, non-code couplings are visible, the change-scoped filter works, and the structural view is unregressed.

---

## Phase 7 — Settings, enablement wiring, docs & polish

**Goal:** Add the sub-toggles, gate every surface on them, document, finalize defaults. **Owner:** Backend Architect + Technical Writer.

**Context the owner needs:** `package.json` `contributes.configuration.properties` (existing `damocles.compass.*` entries are the template); the `vscode.workspace.getConfiguration('damocles. compass').get(...)` read pattern; `moduleToolNames` gating; the enablement checks added in Phases 2–6.

### Work items & acceptance criteria

1. `package.json`: add `damocles.compass.systemMap.enabled` (bool, default **false**), `.coChange.enabled`, `.capabilityIndex.enabled`, `.architectureDigest.enabled`, `.gate.enabled` (the hold-once gate; default true when systemMap on), `.coChange.minSupport` (default 3), `.coChange.minConfidence` (default 0.5), `.coChange.historyLimit` (default 1000), `.coChange.maxCommitFiles` (default 50), `.coChange.minHistory` (default 20), `.capabilityIndex.idleSeconds` (default 180, mirrors `memory.autoExtract.idleSeconds`).
   - **AC:** Settings appear under Compass in VS Code; defaults documented; all namespaced `systemMap.`.
2. `CompassService`: `isSystemMapEnabled` + per-lens getters reading `damocles.compass.systemMap.*`, requiring `isEnabled` (Compass) as a precondition. Thread thresholds into the miner/recompute and the idle interval into the capability queue (replacing Phase 0/4 constants).
   - **AC:** With `compass.enabled=false`, every System Map behavior is inert regardless of sub-toggles; each lens/gate toggles live mid-session (mirroring memory/compass live-toggle).
3. Gate every surface on its toggle: tool active-set (`moduleToolNames` via `isSystemMapEnabled`), hold-once gate (`gate.enabled`), per-turn injection (`architectureDigest.enabled`), co-change recompute (`coChange.enabled`), capability queue + backfill (`capabilityIndex.enabled`).
   - **AC:** Disabling a sub-toggle removes exactly its surface and nothing else; toggling on activates without reload (tools are built inert up front per the existing pattern). Disabling `capabilityIndex` mid-backfill aborts it cleanly.
4. Docs: create a user-facing `docs/system-map.md` (settings/usage: thresholds, the hold-once gate, the capability idle interval, the `.damocles/system-map.md` curation file). **Privacy:** state plainly that enabling `capabilityIndex` sends source snippets to the configured sub-call model (same model/boundary as memory; default off; opt-in).
   - **AC:** Docs reflect shipped behavior, the locked decisions, and the Lens A data boundary.

### Files

- `package.json`, `compass/index.ts`, `co-change.ts`/`co-change-store.ts`, `tools/index.ts`, `agent-start.ts`, `pi-session.ts`, `docs/system-map.md` (new user-facing doc); `__tests__/` for enablement gating.

### Verification

- `npm run typecheck`; `npx vitest run` (enablement gating); `npm run lint`; `npm run build`; `npm run package` (vsce — proves the contributed settings + bundled worker package cleanly).
- **Proves:** all surfaces are independently and live-toggleable, Compass-gated, and shippable.

---

## Risks & mitigations

| Risk | Mitigation | Enforced in |
| --- | --- | --- |
| Co-change noise (lockfiles "change with everything") | Directional confidence + support floor + idf; proven on a real repo before wiring | `co-change.ts`, Phase 0 |
| Co-change drops non-code files (the high-value signal) | Path-keyed `cochange` table (not node-keyed); synthetic file nodes in the graph view | §5, Phases 1 & 6 |
| Path-key mismatch silently empties all joins (esp. subdirectory/monorepo workspace) | Single key space: re-anchor `git log` paths onto the workspace exactly like `getChangedFiles`; project-scoped `git log -- <workspace>`; a fixture test asserts a subdirectory workspace's keys match Compass `file_path` | §6, Phase 0/1 |
| Polluting structural queries (blast radius/dead-code/communities) | Separate `cochange` table; `edges` untouched; blast-radius no-regression test | §5, Phase 1 |
| Gate fatigue / infinite loop | Hold-once: fires at most once per `userEntryId` (per-turn flag) + one-shot `holdNextAgentEnd`; only above `minConfidence`; agent may `[skip …]` | `tryCompletenessGate`, Phase 3 |
| Spurious checkpoint commit from the gate | Gate **peeks** the staged diff (`peekChangedFiles`, no commit); finalize stays deferred | Phase 3 |
| Missing files edited via shell/codegen | Use the checkpoint staged diff, not Edit-tool message scanning | Phase 3 |
| Model called too often / mid-turn contention | Capabilities on a decoupled idle queue that pauses on `isStreaming`/`observedAgentRun`; co-change never calls the model and refreshes on commits only; watcher debounces+batches; hash-skip | Decision 10, Phase 4 / §6 |
| Cost spike on first index of a large repo | Rate-limited resumable backfill (batches of 5, ~3s apart, abortable); partial search results meanwhile | Phase 4 |
| Token overhead of per-turn injection | Distance filter (1–2 hops of edit set) + small digest + hard budget | `buildSystemMapContext`, Phase 5 |
| "Semantic" search that's only keyword match | Reuse `query-expansion` synonym expansion over the capability FTS | Phase 4 |
| Capability rows orphaned by an extraction-format wipe | Prune capability rows whose `file_path` is absent from `nodes` on each build | Phase 4 |
| Migration wiping the graph | Bump schema version (additive); never extraction-format; data in separate tables | `migrations.ts`, Phases 1/4/5 |
| Worker transaction safety | Reads are LIGHT; recompute in heavy path; no light-drain in a txn | `compass-worker.ts`, Phases 1/2 |
| Windows path casing | Reuse the shared re-anchoring helpers `toRepoAbsolute`/`reanchorOnWorkspace`/`isWithinRoot`/`normalizePath` from `compass/util.ts` (the reanchoring pair extracted there in Phase 0) | `co-change.ts`, Phases 0/1 |
| No sub-call model (Lens A/C) | Fail-soft `hasAuthedSubCallModel()` guard → no-op, retain prior rows | Phases 4/5 |
| Model unreachable from the worker thread (would break Lens A/C entirely) | Model calls run MAIN-side in `SystemMapService`; rows written into the worker via `mcp:systemMap:putCapabilities`; worker stays model-free | §5b, Phases 4/5 |
| Empty/shallow git history or missing git | `mineCoChange` returns `{records:[],commits:0}`; `runGit` errors caught; feature inert, no throw | Phases 0/1 |
| False couplings from giant "misc"/squash commits | Skip commits > `maxCommitFiles` (default 50) + `minSupport ≥ 3` recurrence floor (industry standard) | §6, Phase 0 |
| Confidently-wrong advice on young/thin repos | Self-suppress co-change below `minHistory` commits (default 20); gate/injection treat as no-data until history accrues | §6, Phases 0/3 |
| Sending proprietary source to the sub-call model | Same model/boundary memory already uses (no new boundary); `capabilityIndex` default off (opt-in); documented in Phase 7 | §6, Phase 7 |
| Incremental latency from re-mining | Cache `file_change_stats`; gate full re-mine behind a commit-delta check | Phase 1 |

## Open questions (non-blocking; defaults chosen, override anytime)

- **History limit:** defaulted to 1000 commits — re-tune after seeing Phase 0 output on the IEMIS Laravel repo (the recommended first real-data test).
- **Hot-file threshold for per-function summaries:** start with a node-count/centrality cutoff; tune in Phase 4 against sub-call volume.

## Critical files (orientation for any implementer, with no prior context)

- `src/extension/compass/git.ts` + `src/extension/compass/util.ts` — git plumbing the miner extends (foundation of the $0 Lens B signal); `util.ts` is the authoritative home for path re-anchoring (`isWithinRoot`/`normalizePath` today, plus `toRepoAbsolute`/`reanchorOnWorkspace` extracted from `git.ts` in Phase 0).
- `src/extension/compass/migrations.ts` — schema-vs-extraction-format versioning; the wrong bump wipes the graph.
- `src/extension/compass/database.ts` + `schema.ts` — `GraphStore`; `communities`/`flows` are the template for the new isolated `cochange`/`capabilities`/`systems` tables.
- `src/extension/compass/impact.ts` — `computeBlastRadius` (reads `edges` with no kind filter — the reason co-change must stay in its own table); reused by the expansion engine.
- `src/extension/compass/compass-worker.ts` — `dispatch()` + `LIGHT_TYPES` + build/post-process; all new worker requests + the recompute hooks land here under transaction-safe scheduling.
- `src/extension/pi-session/tools/compass-tools.ts` — the exact tool pattern (`COMPASS_SPECS` source of truth, `defineTool`, catalog/gateable wiring) the three System Map tools mirror.
- `src/extension/pi-session/agent-start.ts` (`buildAgentStartResult` → `buildCompassContext`, the per-turn injection seam for Lens C) + `pi-session.ts` (`onParentAgentEnd`/`tryPlanModeHold`, the hold-once gate insertion point — copy the inject-and-hold pattern: `sendCustomMessage({…},{deliverAs:"followUp",triggerTurn:true})` + `deferNextFinalize()` + `holdNextAgentEnd()`).
- `src/extension/pi-session/pi-stream-adapter.ts` (`holdNextAgentEnd`, the `agent_end` handler, `observedAgentRun`) — the one-shot hold boolean (loop safety) and the turn-active signal the capability queue polls; its `message_start` handler renders a bubble only for `role === 'assistant'`, so `display:false` custom notes are never shown (no suppression registration needed).
- `src/extension/pi-session/checkpoints/repo-manager.ts` + `auto-checkpoint.ts` (`finalizeRun` = `stageAll` + `diffAgainst(beforeCommit)` → `parseDiffStats`) + `checkpoint-service.ts` (`deferNextFinalize` / the `onAgentEnd` guard) — the per-turn staged diff; the gate adds a read-only `peekChangedFiles()` (stage + `diffAgainst`, no commit) because the hold path defers finalize, so the diff isn't produced for the held turn.
- `src/extension/memory/index.ts` (`armIdleTimer`, consolidation serialization, `startBackfill`) — the idle-queue + resumable-backfill pattern the capability queue copies; its model seam is `createMemorySubCallRunner()` (it never imports `PiRuntime` directly), which `SystemMapService` reuses.
- `src/extension/compass/compass-worker.ts` + `worker-vscode-shim.js` — proof the worker has **no model access** (stubbed `vscode`, `worker_threads`): the reason capability/digest generation must run main-side (§5b) and only their finished rows are sent into the worker.
- `src/extension/memory/subcall-runner.ts` + `query-expansion.ts` — the no-local-model sub-call + synonym-expansion pattern reused for capability summaries and search.
