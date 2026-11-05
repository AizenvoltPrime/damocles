# Compass, the workspace knowledge graph

This page covers Compass, which indexes your workspace into a persistent, queryable code graph that the agent and the editor UI read.

Compass is disabled by default; enable it via `damocles.compass.enabled`.

## What it indexes

Compass converts your workspace into a persistent, queryable knowledge graph via tree-sitter AST extraction across 15 languages (Python, JS/TS/TSX, Go, Rust, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, **Vue SFC**). It is backed by SQLite via Node's built-in `node:sqlite` (FTS5), so the graph survives VS Code restarts with zero re-indexing.

## Agent tools

The agent queries the graph via 8 MCP tools:

| Group | Tools |
| --- | --- |
| core | `compass_search`, `compass_query`, `compass_context`, `compass_stats` |
| impact | `compass_blast_radius`, `compass_review_context` |
| analysis | `compass_dead_code` |
| admin | `compass_build` |

`compass_review_context` auto-detects changed files via git when no file list is provided. Every `compass_query` response states what the target resolved to (name, kind, `path:line`), lists alternate matches on ambiguity, and flags empty relationship results for verification, so a "none" is diagnosable rather than silently wrong. All tools support `detail_level` (minimal/summary/full) for token efficiency.

## Capabilities

- **Search**: FTS5 BM25 search with camelCase/snake_case tokenization, plus parent-class and directory tokens, so a query naming a class surfaces its methods.
- **Blast radius analysis**: BFS from changed files through all edge kinds, bounded non-lossily on hub nodes.
- **Risk-scored review context**: flow-criticality-weighted impact + test gaps + affected flows, with a context-savings estimate.
- **Test-coverage edges**: `tests_for` / test-gap risk, derived from tests that call production code, recognizing Rust `#[test]`, PHPUnit camelCase, and `@Test`/`[Fact]`-family annotations, with a class-name fallback for DI-heavy tests.
- **Dead-code detection**: unreferenced functions/classes, excluding entry points and framework-managed classes. Constructor/static calls and type-hint/DI-injected dependencies are tracked across all languages, so constructor-injected services aren't false-flagged.
- **Execution flow tracing** with criticality scoring: framework decorators and entry-name conventions across 15+ stacks; test files are excluded from production flows.
- **Louvain community detection**: adaptive resolution scales inversely with graph size; directory-based fallback above 20K nodes.

## Editor UI

- An interactive D3 force-directed graph visualization in the webview with community coloring, blast radius overlay, and click-to-navigate.
- A VS Code sidebar tree view, search panel, validation panel (broken edges, orphans, stale files), editor gutter decorations for blast radius, and a status bar item.

## Updates and resilience

Incremental updates are watcher-fed, so newly created files are indexed within seconds without a rebuild (large bursts like branch switches fall back to one git diff), with SHA-256 caching, transitive dependent invalidation, and a WAL checkpoint skipped when the graph hasn't changed.

A corrupt graph cache self-heals on startup, and repeated worker crashes trip a circuit breaker ("Compass failed. Run Rebuild to retry") instead of looping. Compass works on Windows (drive-letter casing, `/`-style `excludePatterns`) and in monorepos where the workspace is a subfolder of the git repo.

## Workspace trust

Compass is withheld entirely in a workspace you have not trusted, because indexing reads every file in the tree and runs git inside the repository, where the repository's own `.git/config` decides what git executes. In that state there is no index, no file watcher, no sidebar views and no Compass tools, and granting trust starts it with no window reload.
