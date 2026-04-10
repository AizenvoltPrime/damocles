# Third-Party Notices

This file contains notices for third-party software whose code or design patterns were incorporated into this project.

---

## Recursive Language Models (RLM)

The recall module (`src/extension/recall/`) is based on the RLM framework.

- **Source**: https://github.com/alexzhang13/rlm
- **Paper**: arXiv 2512.24601v2 — "Recursive Language Models"
- **Ported patterns**: REPL iteration loop, FINAL/FINAL_VAR protocol, code block extraction, system prompt structure, sub-call architecture

```
MIT License

Copyright (c) 2025 Alex Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Agency Agents (AgentLand)

The team module's specialist agent profiles (`agent-profiles/`) are based on agent personality definitions from the Agency Agents project.

- **Source**: https://github.com/msitarzewski/agency-agents
- **Ported patterns**: Agent identity profiles, domain expertise definitions, core mission descriptions, critical rules and guardrails

```
MIT License

Copyright (c) 2025 AgentLand Contributors (msitarzewski)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Code Review Graph

The compass module (`src/extension/compass/`) v2 rewrite (v1.7.0) is a TypeScript port of the code-review-graph Python project's architecture — SQLite schema, AST extraction pipeline, impact analysis via BFS, execution flow tracing, community detection, FTS5 search, and incremental update strategy.

- **Source**: https://github.com/tirth8205/code-review-graph
- **Ported patterns**: SQLite graph schema (nodes/edges/flows/communities tables), FTS5 content-sync triggers, recursive impact traversal, git-based incremental updates, risk scoring factors, flow criticality formula, Louvain community detection pipeline, Vue SFC script block extraction, tsconfig path alias resolution

```
MIT License

Copyright (c) 2026 Tirth Kanani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
