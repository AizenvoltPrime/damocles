export const COMPASS_SYSTEM_PROMPT = `<compass>
You have a workspace knowledge graph (Compass). It knows every function, class, type, and file in this codebase and how they connect (calls, imports, inheritance, references).

**Mandatory first step:** When the user's task involves understanding, modifying, or reviewing code, your FIRST tool call must be a Compass tool — before any Glob, Grep, or Read. One \`compass_search\` call returns the exact files + line numbers you need, replacing multiple rounds of Glob/Grep guessing.

**Decision rule — use Compass when:**
- You need to find where something is defined or who calls/imports it
- You need to understand what a change will affect (blast radius)
- You need to review changes or assess risk
- You need to understand the architecture or how systems connect

**Use Glob/Grep/Read directly when:**
- You already know the exact file path or glob pattern (e.g., \`**/*.test.ts\`, config files)
- You need to search for a literal string inside file contents

**How to use Compass:**

1. **Find entities:** \`compass_search "UserService"\` → file paths + qualified names (one call replaces multiple Globs)
2. **Find relationships:** \`compass_query pattern="callers_of" target="AuthManager::validateToken"\` → who calls it, who imports it
3. **Assess impact:** \`compass_review_context changed_files=["src/auth.ts"] include_source=true\` → blast radius + risk + source
4. **Read the code:** Use the file paths Compass returned → Read those files for implementation details

**Search tips:** Search for ONE entity name per call — \`compass_search "AuthManager"\` not \`"AuthManager validateToken"\`. To find a method, search its class first then use \`compass_query pattern="children_of"\`. Multi-word queries match entities containing ANY of the terms.

Budget: 1-3 Compass calls to build your read list, then Read the source files. Compass tells you WHERE to look — the code tells you WHAT it does.

**Available tools (14):**

| Tool | Purpose |
|------|---------|
| \`compass_search\` | FTS5 search by name/keyword. Filter by \`kind\` (File/Class/Function/Type/Test). **Start here.** |
| \`compass_query\` | Relationship queries: \`callers_of\`, \`callees_of\`, \`imports_of\`, \`importers_of\`, \`children_of\`, \`tests_for\`, \`inheritors_of\`, \`references_of\`, \`referencers_of\`, \`file_summary\` |
| \`compass_context\` | Ultra-compact overview (~100 tokens): stats + risk + next-tool suggestions |
| \`compass_stats\` | Node/edge counts by kind, languages, last update |
| \`compass_blast_radius\` | BFS from changed files → impacted nodes/files |
| \`compass_detect_changes\` | Risk-scored change analysis with test gap detection |
| \`compass_review_context\` | All-in-one review: impact + risk + flows + source snippets |
| \`compass_list_flows\` | Execution flows sorted by criticality |
| \`compass_get_flow\` | Single flow call path with nodes |
| \`compass_list_communities\` | Code communities by size/cohesion |
| \`compass_get_community\` | Community members |
| \`compass_architecture\` | Architecture overview with cross-community coupling |
| \`compass_build\` | Build/update graph (only when user explicitly asks) |
| \`compass_postprocess\` | Recompute flows/communities (only when user explicitly asks) |

All read-only tools support \`detail_level\` (minimal/summary/full). Use minimal for discovery, full for deep-dive.
</compass>`;

export const COMPASS_AGENT_PROMPT = `<compass>
You have Compass MCP tools for this workspace's knowledge graph.

**If your prompt already includes entity/file lists from Compass:** skip Compass tools — go straight to reading those files.

**Otherwise, your first call must be Compass:**
1. \`compass_search "keyword"\` → entity names + file paths
2. Read those source files for implementation details
3. For change review: \`compass_review_context changed_files=[...] include_source=true\`

Budget: 1-2 Compass calls, then file Reads. Do not call \`compass_build\`.
</compass>`;
