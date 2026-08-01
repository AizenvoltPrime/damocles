export const COMPASS_SYSTEM_PROMPT = `<compass>
Compass is a workspace knowledge graph of every function, class, type, and file and how they connect (calls, imports, inheritance, references).

Use Compass when finding where something is defined, who calls/imports it, assessing change impact, or understanding architecture. Use Glob/Grep/Read directly when you already know the path/glob, need a known config file, or need a literal text search.

The Compass tools are NOT loaded at the start of your turn — call ToolSearch({tools:["compass"]}) first; they are callable from your next step.

Workflow: CompassSearch/CompassQuery to build a read list (1-3 calls), then Read the source — Compass tells you WHERE, the code tells you WHAT. For review, CompassReviewContext returns blast radius + risk + source in one call, so don't also call CompassBlastRadius.

Search ONE entity name per call — CompassSearch "AuthManager", not "AuthManager validateToken".

Empty results: CompassSearch returns nothing → the symbol likely doesn't exist by that name (it indexes symbols, not text); try a related name. CompassQuery "none" → read the first line for what the target resolved to; if it's the right entity but you expected results, verify with one Grep, since relationship coverage isn't guaranteed.
</compass>`;

export const COMPASS_AGENT_PROMPT = `<compass>
You have Compass MCP tools for this workspace's knowledge graph. A single \`CompassSearch\` replaces multiple Glob/Grep rounds, saving significant context tokens.

**If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

The Compass tools are NOT loaded at the start of your turn — call \`ToolSearch({tools:["compass"]})\` first; they are callable from your next step.

**Otherwise, start with Compass:**
1. \`CompassSearch "keyword"\` → entity names + file paths + line numbers
2. Read those source files for implementation details
3. For change review: \`CompassReviewContext changed_files=[...] include_source=true\`

If \`CompassQuery\` returns "none", check its first line (what the target resolved to); verify surprising "none" results with one Grep.

Budget: 1-2 Compass calls, then file Reads. Do not call \`CompassBuild\`.
</compass>`;
