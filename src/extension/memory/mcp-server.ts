import type { MemoryService } from './index';
import type { ObservationType, ObservationTag, MemoryTier, SearchQuery } from '@shared/types/memory';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function createMemoryMcpServer(
  memoryService: MemoryService,
  createSdkMcpServer: SdkCreateServer,
  tool: SdkTool,
  z: ZodZ,
  getSessionId: () => string,
  workspace: string
): ReturnType<SdkCreateServer> {
  return createSdkMcpServer({
    name: 'damocles-memory',
    version: '1.0.0',
    tools: [
      tool(
        'save_observation',
        'Record a structured observation about work you completed. Use after implementing features, fixing bugs, making architectural decisions, or discovering important patterns.',
        {
          type: z.enum(['implementation', 'fix', 'refactor', 'architecture', 'insight', 'environment']).describe('Type of observation'),
          title: z.string().describe('Short title (max 80 chars)'),
          content: z.string().describe('Narrative explaining what/how/why'),
          facts: z.array(z.string()).describe('3+ concise facts about the work'),
          observation_tags: z.array(z.enum(['mechanism', 'rationale', 'impact', 'caveat', 'approach', 'dependency', 'performance'])).optional().describe('Relevant tags'),
          files_read: z.array(z.string()).optional().describe('File paths read during work'),
          files_modified: z.array(z.string()).optional().describe('File paths modified during work'),
        },
        async (input) => {
          const result = memoryService.addObservation(getSessionId(), workspace, {
            type: input.type as ObservationType,
            title: input.title,
            content: input.content,
            facts: input.facts,
            observationTags: (input.observation_tags as ObservationTag[] | undefined) ?? [],
            filesRead: input.files_read ?? [],
            filesModified: input.files_modified ?? [],
          });
          if (!result) return textResult('Failed to save observation');
          return textResult(`Observation saved: ${result.title} (${result.id})`);
        }
      ),

      tool(
        'search_memories',
        'Search past observations, notes, and memories. Returns a compact index (~30 tokens/result). Use get_memory_details for full content.',
        {
          query: z.string().optional().describe('Text search query'),
          files: z.array(z.string()).optional().describe('Filter by file paths'),
          types: z.array(z.string()).optional().describe('Filter by observation types'),
          tiers: z.array(z.string()).optional().describe('Filter by memory tiers'),
          since: z.string().optional().describe('ISO date string for start range'),
          until: z.string().optional().describe('ISO date string for end range'),
          limit: z.number().optional().describe('Max results (default 20)'),
        },
        async (input) => {
          const searchQuery: SearchQuery = {};
          if (input.query) searchQuery.query = input.query;
          if (input.files) searchQuery.files = input.files;
          if (input.types) searchQuery.types = input.types as ObservationType[];
          if (input.tiers) searchQuery.tiers = input.tiers as MemoryTier[];
          if (input.since) searchQuery.since = new Date(input.since).getTime();
          if (input.until) searchQuery.until = new Date(input.until).getTime();
          if (input.limit !== undefined) searchQuery.limit = input.limit;

          const results = memoryService.searchMemories(searchQuery);
          if (results.length === 0) return textResult('No memories found matching query.');
          return textResult(JSON.stringify(results));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'get_memory_details',
        'Get full details for specific memory IDs. Use after search_memories to fetch complete content.',
        {
          ids: z.array(z.string()).describe('Memory IDs to retrieve'),
        },
        async (input) => {
          const MAX_DETAIL_IDS = 5;
          if (input.ids.length > MAX_DETAIL_IDS) {
            return textResult(`Too many IDs requested (${input.ids.length}). Maximum ${MAX_DETAIL_IDS} per call to prevent context overflow. Request the most relevant IDs only.`);
          }
          const entries = memoryService.getMemoryDetails(input.ids);
          if (entries.length > 0) {
            memoryService.recordRetrievals(entries.map(e => e.id), workspace);
          }
          if (entries.length === 0) return textResult('No memories found for given IDs.');
          return textResult(JSON.stringify(entries));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'get_timeline',
        'Get chronological context around a specific memory/observation.',
        {
          anchor_id: z.string().describe('Memory ID to center timeline around'),
          before: z.number().optional().describe('Number of entries before anchor (default 5)'),
          after: z.number().optional().describe('Number of entries after anchor (default 5)'),
        },
        async (input) => {
          const entries = memoryService.getTimeline(input.anchor_id, input.before, input.after, workspace);
          if (entries.length === 0) return textResult('No timeline entries found.');
          return textResult(JSON.stringify(entries));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'save_note',
        'Save a knowledge base note for future reference.',
        {
          content: z.string().describe('Note content'),
          tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
        },
        async (input) => {
          const note = memoryService.addNote(input.content, input.tags);
          if (!note) return textResult('Failed to save note.');
          return textResult(`Note saved (${note.id})`);
        }
      ),

      tool(
        'list_notes',
        'List all knowledge base notes.',
        {
          tags: z.array(z.string()).optional().describe('Optional tag filter'),
        },
        async (input) => {
          const notes = memoryService.listNotes(input.tags);
          if (notes.length === 0) return textResult('No notes found.');
          return textResult(JSON.stringify(notes));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'reset_observation_staleness',
        'Mark an observation as fresh after verifying its content is still accurate. Use when an observation is marked [stale] but you have confirmed it remains valid.',
        {
          id: z.string().describe('Observation ID to reset staleness for'),
        },
        async (input) => {
          const success = memoryService.resetObservationStaleness(input.id);
          if (!success) return textResult('Failed to reset staleness. Memory system may be disabled.');
          return textResult(`Staleness reset for observation ${input.id}`);
        }
      ),

      tool(
        'pin_memory',
        'Pin a memory for guaranteed injection into every prompt. Pinned memories bypass the catalog and are always shown in full.',
        {
          id: z.string().describe('Memory ID to pin'),
        },
        async (input) => {
          const success = memoryService.pinMemory(input.id);
          if (!success) return textResult('Failed to pin memory. ID may not exist or memory system may be disabled.');
          return textResult(`Memory ${input.id} pinned. It will appear in full in every prompt.`);
        }
      ),

      tool(
        'unpin_memory',
        'Remove a memory from the pinned set, returning it to the catalog.',
        {
          id: z.string().describe('Memory ID to unpin'),
        },
        async (input) => {
          const success = memoryService.unpinMemory(input.id);
          if (!success) return textResult('Failed to unpin memory. ID may not exist or memory system may be disabled.');
          return textResult(`Memory ${input.id} unpinned. It will return to the catalog.`);
        }
      ),
    ],
  });
}
