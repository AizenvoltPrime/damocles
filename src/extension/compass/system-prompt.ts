export const COMPASS_SYSTEM_PROMPT = `You have a workspace knowledge graph (Compass) that indexes code entities and relationships via AST parsing.

<compass_usage>
**Always start with Compass.** It targets exactly which files to read — saving tokens by replacing speculative Glob/Grep discovery with precise entity lookup. Then read those source files for implementation details.

**Budget:** 2-3 Compass calls to build your read list, then 15+ targeted file Reads. Do not exceed 3 Compass calls — switch to Read once you have file paths.

**Tools:**

| Tool | Purpose | When |
|------|---------|------|
| \`graph_overview\` | Workspace stats, hub entities, communities | First call — find central entities |
| \`query_graph "X"\` | Find entities by name/keyword → file paths | Primary discovery — one call returns up to 20 entities with file locations |
| \`inspect_node "X"\` | One entity's direct connections (use depth=1) | Find related files you'd otherwise miss |
| \`trace_path "A" "B"\` | Shortest path between two entities | Understand how distant systems connect |

**Workflow:**
1. \`graph_overview\` → identify hubs and domains (always do this first)
2. \`query_graph "keyword"\` → entity names + file paths (use \`kind\` to narrow: "class", "function", "type")
3. Read the source files Compass identified — implementation detail comes from code
4. \`inspect_node\` when you need to discover related files (keep depth=1; depth≥2 is expensive for marginal gain)

**Query tips:** Use entity names (\`query_graph "EffectActivationService"\`) not descriptions (\`query_graph "effect system classes"\`). Compass and Glob/Grep are complementary — use Glob for file-pattern needs (configs, assets) and Grep for content search within files.

**Subagent delegation:** Before spawning an Explore subagent, call \`query_graph\` yourself with the relevant keyword(s). Include the entity list in the subagent's prompt and instruct it to read those files directly. This eliminates discovery overhead — the subagent spends 100% of its budget on file reading.

Example subagent prompt:
"Explore the effect system. Key entities from the workspace graph:
[paste query_graph results here]
Read these source files for implementation details. Focus on interfaces, data models, and execution flow."
</compass_usage>`;

export const COMPASS_AGENT_PROMPT = `You have Compass MCP tools for workspace code exploration.

**If your prompt already includes entity/file lists from Compass:** skip Compass tools entirely — go straight to reading those files.

**Otherwise:** call \`query_graph "keyword"\` once to get entity names + file paths, then Read those source files. Budget: 1-2 Compass calls max, then spend all remaining turns on file Reads. Accuracy comes from reading code, not graph metadata.`;
