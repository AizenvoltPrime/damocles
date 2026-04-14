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
