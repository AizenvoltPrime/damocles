import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { CompassService } from '../../compass';
import type { ToolCatalogEntry } from '@shared/types/tools';

/**
 * pi-native re-wrap of the `damocles-compass` SDK MCP server (US-006). Each tool keeps the EXACT
 * handler body of `compass/mcp-server.ts` — only the schema (Zod → TypeBox), the result wrapper, and
 * the NAME change. Tools are exposed under PascalCase active-set names (`CompassSearch`, …). Compass
 * is purely read-only, so every tool is also safe to expose in plan mode. `COMPASS_SPECS` is the
 * single source of truth for the active-set names, the `defineTool` names, and the Tools-panel catalog.
 */

interface ToolSpec {
  /** Original snake_case identity (parity-test mapping only). */
  key: string;
  /** PascalCase active-set name + `defineTool` name + label source. */
  name: string;
  /** Human-friendly Tools-panel label. */
  label: string;
  /** One-line Tools-panel blurb. */
  description: string;
}

const COMPASS_SPECS: readonly ToolSpec[] = [
  { key: 'compass_context', name: 'CompassContext', label: 'Compass context', description: 'Ultra-compact workspace overview.' },
  { key: 'compass_search', name: 'CompassSearch', label: 'Compass search', description: 'Find code entities by name or keyword.' },
  { key: 'compass_query', name: 'CompassQuery', label: 'Compass query', description: 'Relationship queries between code entities.' },
  { key: 'compass_stats', name: 'CompassStats', label: 'Compass stats', description: 'Knowledge graph statistics.' },
  { key: 'compass_blast_radius', name: 'CompassBlastRadius', label: 'Blast radius', description: 'Impact analysis from changed files.' },
  { key: 'compass_review_context', name: 'CompassReviewContext', label: 'Review context', description: 'Change review with impact, risk, and flows.' },
  { key: 'compass_dead_code', name: 'CompassDeadCode', label: 'Dead code', description: 'Find functions/classes with no references.' },
  { key: 'compass_build', name: 'CompassBuild', label: 'Compass build', description: 'Build or update the knowledge graph.' },
] as const;

const NAME_BY_KEY: Record<string, string> = Object.fromEntries(COMPASS_SPECS.map((s) => [s.key, s.name]));
/** The PascalCase active-set/`defineTool` name for a compass tool key. */
const n = (key: string): string => NAME_BY_KEY[key]!;

export const COMPASS_PI_TOOL_NAMES: readonly string[] = COMPASS_SPECS.map((s) => s.name);

export const COMPASS_TOOL_CATALOG: readonly ToolCatalogEntry[] = COMPASS_SPECS.map((s) => ({
  name: s.name,
  label: s.label,
  description: s.description,
  group: 'compass',
  toggleable: true,
}));

export interface CompassPiToolDeps {
  pi: PiCodingAgentModule;
  compassService: CompassService;
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

const detailLevel = (description: string) =>
  Type.Optional(Type.Union(['minimal', 'summary', 'full'].map((v) => Type.Literal(v)), { description }));

const compassContextSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ description: 'Current task description for targeted suggestions' })),
    changed_files: Type.Optional(Type.Array(Type.String(), { description: 'Changed file paths for risk assessment' })),
    base: Type.Optional(Type.String({ description: 'Git ref to diff against' })),
  },
  { additionalProperties: false },
);

const compassSearchSchema = Type.Object(
  {
    query: Type.String({ description: 'Entity name or keyword' }),
    kind: Type.Optional(
      Type.Union(['File', 'Class', 'Function', 'Type', 'Test'].map((v) => Type.Literal(v)), {
        description: 'Filter by entity type',
      }),
    ),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: 'Max results (default 20)' })),
    detail_level: detailLevel('Output detail'),
  },
  { additionalProperties: false },
);

const compassQuerySchema = Type.Object(
  {
    pattern: Type.Union(
      ['callers_of', 'callees_of', 'imports_of', 'importers_of', 'children_of', 'tests_for', 'inheritors_of', 'references_of', 'referencers_of', 'file_summary'].map((v) => Type.Literal(v)),
      { description: 'Query pattern' },
    ),
    target: Type.String({ description: 'Qualified name or entity name to resolve. For importers_of/imports_of use a file name with extension or a path-qualified name.' }),
    detail_level: detailLevel('Output detail'),
  },
  { additionalProperties: false },
);

const compassStatsSchema = Type.Object({}, { additionalProperties: false });

const compassBlastRadiusSchema = Type.Object(
  {
    changed_files: Type.Array(Type.String(), { description: 'Changed file paths' }),
    max_depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: 'Max traversal depth (default 2)' })),
    max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 2000, description: 'Max impacted nodes (default 500)' })),
    detail_level: detailLevel('Output detail'),
  },
  { additionalProperties: false },
);

const compassReviewContextSchema = Type.Object(
  {
    changed_files: Type.Optional(Type.Array(Type.String(), { description: 'Changed file paths (omit to auto-detect via git)' })),
    max_depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: 'Blast radius depth' })),
    include_source: Type.Optional(Type.Boolean({ description: 'Include source code snippets' })),
    base: Type.Optional(Type.String({ description: 'Git ref to diff against' })),
  },
  { additionalProperties: false },
);

const compassDeadCodeSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.Union(['Function', 'Class'].map((v) => Type.Literal(v)), { description: 'Restrict to one entity kind (default: both)' }),
    ),
    file_pattern: Type.Optional(Type.String({ description: 'Only report symbols whose file path contains this substring' })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: 'Max results to list (default 100)' })),
  },
  { additionalProperties: false },
);

const compassBuildSchema = Type.Object(
  {
    full_rebuild: Type.Optional(Type.Boolean({ description: 'Force full rebuild (default: incremental)' })),
    postprocess: Type.Optional(Type.Boolean({ description: 'Run post-processing (default: true)' })),
  },
  { additionalProperties: false },
);

/** Build the `damocles-compass` tools as pi-native definitions, reusing the SDK handler logic verbatim. */
export function buildCompassPiTools(deps: CompassPiToolDeps): ToolDefinition[] {
  const { pi, compassService } = deps;

  return [
    pi.defineTool<typeof compassContextSchema, undefined>({
      name: n('compass_context'),
      label: n('compass_context'),
      description: 'Ultra-compact workspace overview (~100 tokens). Stats + risk + next tool suggestions.',
      parameters: compassContextSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpContext(input));
      },
    }),

    pi.defineTool<typeof compassSearchSchema, undefined>({
      name: n('compass_search'),
      label: n('compass_search'),
      description: "Primary tool for finding code entities (functions, classes, types, files) by name or keyword. Use this BEFORE Glob/Grep when targeting symbols, definitions, or call sites — one call returns exact paths and line numbers, replacing 3-5 rounds of pattern guessing. Use Grep only for literal text searches in file contents (error strings, log lines, comments). If it returns nothing, the symbol likely doesn't exist under that name — try a variant before Grep.",
      parameters: compassSearchSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpSearch(input));
      },
    }),

    pi.defineTool<typeof compassQuerySchema, undefined>({
      name: n('compass_query'),
      label: n('compass_query'),
      description: 'Primary tool for relationship queries between code entities (callers, callees, imports, children, tests, inheritors, references). Use this BEFORE reading files to map blast radius and locate call sites. The first line of every response shows what the target resolved to (name, kind, path) — confirm it is the entity you meant before trusting an empty result. For importers_of/imports_of pass a file name with extension or a path-qualified name (e.g. "ErrorPopup.vue"); bare symbol names are fine for callers_of/children_of. references_of = outgoing (what X references); referencers_of = incoming (who references X). If a relationship returns "none" where you expected results, verify with one Grep — index coverage is not guaranteed.',
      parameters: compassQuerySchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpQuery(input));
      },
    }),

    pi.defineTool<typeof compassStatsSchema, undefined>({
      name: n('compass_stats'),
      label: n('compass_stats'),
      description: 'Graph statistics: node/edge counts by kind, languages, last update.',
      parameters: compassStatsSchema,
      execute: async () => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpStats());
      },
    }),

    pi.defineTool<typeof compassBlastRadiusSchema, undefined>({
      name: n('compass_blast_radius'),
      label: n('compass_blast_radius'),
      description: 'Primary tool for impact analysis: BFS from changed files through the dependency graph. Returns affected nodes, files, and edges. Use this BEFORE reviewing a change to scope risk.',
      parameters: compassBlastRadiusSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpBlastRadius(input));
      },
    }),

    pi.defineTool<typeof compassReviewContextSchema, undefined>({
      name: n('compass_review_context'),
      label: n('compass_review_context'),
      description: 'Primary tool for change review: returns impact + risk + affected flows + optional source snippets. Use this when reviewing diffs or assessing pull-request safety. Auto-detects changed files via git when changed_files is omitted.',
      parameters: compassReviewContextSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpReviewContext(input));
      },
    }),

    pi.defineTool<typeof compassDeadCodeSchema, undefined>({
      name: n('compass_dead_code'),
      label: n('compass_dead_code'),
      description: 'Find functions and classes with no incoming references (callers, tests, importers, references, inheritors). Excludes entry points (main/handlers/lifecycle names), constructors, and framework-managed classes. Use to locate prunable dead code.',
      parameters: compassDeadCodeSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpDeadCode(input));
      },
    }),

    pi.defineTool<typeof compassBuildSchema, undefined>({
      name: n('compass_build'),
      label: n('compass_build'),
      description: 'Build or incrementally update the workspace knowledge graph.',
      parameters: compassBuildSchema,
      execute: async (_id, input) => {
        await compassService.ensureInitialized();
        return textResult(await compassService.mcpBuild(input));
      },
    }),
  ];
}
