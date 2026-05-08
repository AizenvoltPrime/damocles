export const COMPASS_SYSTEM_PROMPT = `<compass>
You have a workspace knowledge graph (Compass). It knows every function, class, type, and file in this codebase and how they connect (calls, imports, inheritance, references).

**Fast-path for code targeting:** prefer Compass first when finding, understanding, or reviewing code — including plan-mode exploration. The tool descriptions explain the mechanics; this section explains when each applies.

**Decision rule — use Compass when:**
- You need to find where something is defined or who calls/imports it (\`compass_search\`, \`compass_query\`)
- You need to assess change impact or review for risk (\`compass_review_context\` for full review with risk + flows + optional source; \`compass_blast_radius\` for impact-only when you don't need risk data — review_context already includes blast-radius output, so don't call both)
- You need to understand the architecture or how systems connect

**Use Glob/Grep/Read directly when:**
- You already know the exact file path or glob pattern (e.g., \`**/*.test.ts\`)
- You need to read a known config file (e.g., \`package.json\`, \`tsconfig.json\`, \`.env*\`)
- You need a literal text search inside file contents (error strings, log lines, comment text)

**How to use Compass:**

1. **Find entities:** \`compass_search "UserService"\` → file paths + qualified names
2. **Find relationships:** \`compass_query pattern="callers_of" target="AuthManager::validateToken"\` → who calls it, who imports it
3. **Assess impact:** \`compass_review_context changed_files=["src/auth.ts"] include_source=true\` → blast radius + risk + source
4. **Read the code:** Use the file paths Compass returned → Read those files for implementation details

**Search tips:** Search for ONE entity name per call — \`compass_search "AuthManager"\` not \`"AuthManager validateToken"\`. To find a method, search its class first then use \`compass_query pattern="children_of"\`. Multi-word queries match entities containing ANY of the terms.

**Anti-pattern:** Don't fall through to Grep if \`compass_search\` returns nothing. Compass searches symbols; Grep searches text content. If you expected a symbol and Compass found none, the symbol probably doesn't exist by that name — try \`compass_search\` with a related name or \`compass_query pattern="references_of"\` before Grep.

Budget: 1-3 Compass calls to build your read list, then Read the source files. Compass tells you WHERE to look — the code tells you WHAT it does.
</compass>`;

export const COMPASS_AGENT_PROMPT = `<compass>
You have Compass MCP tools for this workspace's knowledge graph. A single \`compass_search\` replaces multiple Glob/Grep rounds, saving significant context tokens.

**If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

**Otherwise, start with Compass:**
1. \`compass_search "keyword"\` → entity names + file paths + line numbers
2. Read those source files for implementation details
3. For change review: \`compass_review_context changed_files=[...] include_source=true\`

Budget: 1-2 Compass calls, then file Reads. Do not call \`compass_build\`.
</compass>`;
