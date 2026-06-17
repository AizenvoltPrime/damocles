export const COMPASS_SYSTEM_PROMPT = `<compass>
You have a workspace knowledge graph (Compass). It knows every function, class, type, and file in this codebase and how they connect (calls, imports, inheritance, references).

**Fast-path for code targeting:** prefer Compass first when finding, understanding, or reviewing code — including plan-mode exploration. The tool descriptions explain the mechanics; this section explains when each applies.

**Decision rule — use Compass when:**
- You need to find where something is defined or who calls/imports it (\`CompassSearch\`, \`CompassQuery\`)
- You need to assess change impact or review for risk (\`CompassReviewContext\` for full review with risk + flows + optional source; \`CompassBlastRadius\` for impact-only when you don't need risk data — review_context already includes blast-radius output, so don't call both)
- You need to understand the architecture or how systems connect

**Use Glob/Grep/Read directly when:**
- You already know the exact file path or glob pattern (e.g., \`**/*.test.ts\`)
- You need to read a known config file (e.g., \`package.json\`, \`tsconfig.json\`, \`.env*\`)
- You need a literal text search inside file contents (error strings, log lines, comment text)

**How to use Compass:**

1. **Find entities:** \`CompassSearch "UserService"\` → file paths + qualified names
2. **Find relationships:** \`CompassQuery pattern="callers_of" target="AuthManager::validateToken"\` → who calls it, who imports it
3. **Assess impact:** \`CompassReviewContext changed_files=["src/auth.ts"] include_source=true\` → blast radius + risk + source
4. **Read the code:** Use the file paths Compass returned → Read those files for implementation details

**Search tips:** Search for ONE entity name per call — \`CompassSearch "AuthManager"\` not \`"AuthManager validateToken"\`. To find a method, search its class first then use \`CompassQuery pattern="children_of"\`. Multi-word queries match entities containing ANY of the terms. For \`CompassQuery\` targets: \`importers_of\`/\`imports_of\` want a file name with extension (\`ErrorPopup.vue\`) or a path-qualified name; bare symbol names are fine for \`callers_of\`/\`children_of\`. Direction: \`references_of\` lists what X references (outgoing); \`referencers_of\` lists who references X (incoming).

**Interpreting empty results:** If \`CompassSearch\` returns nothing, the symbol probably doesn't exist by that name — Compass searches symbols, Grep searches text — so try a related name first. If \`CompassQuery\` returns "none", read the first line: it shows what the target actually resolved to (name, kind, path). Wrong entity → retry with a more specific target. Right entity but you expected results — especially for \`referencers_of\` or \`tests_for\` — treat "none" as a hypothesis and verify with one Grep; relationship coverage is never guaranteed.

Budget: 1-3 Compass calls to build your read list, then Read the source files. Compass tells you WHERE to look — the code tells you WHAT it does.
</compass>`;

export const COMPASS_AGENT_PROMPT = `<compass>
You have Compass MCP tools for this workspace's knowledge graph. A single \`CompassSearch\` replaces multiple Glob/Grep rounds, saving significant context tokens.

**If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

**Otherwise, start with Compass:**
1. \`CompassSearch "keyword"\` → entity names + file paths + line numbers
2. Read those source files for implementation details
3. For change review: \`CompassReviewContext changed_files=[...] include_source=true\`

If \`CompassQuery\` returns "none", check its first line (what the target resolved to); verify surprising "none" results with one Grep.

Budget: 1-2 Compass calls, then file Reads. Do not call \`CompassBuild\`.
</compass>`;
