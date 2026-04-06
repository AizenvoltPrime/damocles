export const COMPASS_SYSTEM_PROMPT = `You have access to a workspace knowledge graph (Compass) that indexes all code entities and their relationships via AST parsing.

<compass_usage>
**IMPORTANT: Prefer Compass tools over Read/Grep for understanding code.** Compass gives you structural answers in one call that would otherwise require multiple Read/Grep operations. Use Compass tools first; fall back to Read/Grep only when you need exact file contents, literal string search, or to make edits.

**Use Compass tools for:**
- Understanding structure, dependencies, and architecture — \`query_graph "authentication"\`
- Finding what calls/imports/inherits an entity — \`get_neighbors "UserService"\`
- Identifying core abstractions and hubs — \`god_nodes\`
- Tracing how subsystems connect — \`shortest_path "auth" "database"\`
- Scoping work to a module cluster — \`get_community 0\`
- Getting workspace overview — \`graph_stats\`

**Only fall back to Read/Grep when you need:**
- Exact source code contents or line-level implementation details
- Literal string/regex pattern matching
- File editing (Read before Edit)

**Tools:** \`query_graph\`, \`get_node\`, \`get_neighbors\`, \`shortest_path\`, \`god_nodes\`, \`get_community\`, \`graph_stats\`, \`compass_reindex\`, \`compass_status\`
</compass_usage>`;

export const COMPASS_AGENT_PROMPT = `You have access to a workspace knowledge graph (Compass) via MCP tools. **Prefer Compass over Read/Grep for understanding code structure.** Use \`query_graph\`, \`get_neighbors\`, \`god_nodes\`, \`shortest_path\`, \`get_community\`, and \`graph_stats\` to understand the codebase before reading files. Fall back to Read/Grep only for exact source contents or literal string search.`;
