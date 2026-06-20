import * as fs from 'fs/promises';
import * as path from 'path';
import { DAMOCLES_CONFIG_DIR } from './auth/paths';
import type { WorkflowAgentTranscript, WorkflowAgentBlock } from '../shared/types/workflows';

const TOOL_RESULT_PREVIEW = 2000;

interface JournalEntry {
  type?: string;
  agentId?: string;
  result?: unknown;
}

interface AgentMeta {
  agentType?: string;
}

interface AgentJsonlEntry {
  type?: string;
  message?: { role?: string; model?: string; content?: unknown };
}

interface AgentScan {
  prompt: string;
  model: string | null;
  toolUseCount: number;
  blocks: WorkflowAgentBlock[];
}

export function isWithinWorkflowsDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  const base = path.resolve(DAMOCLES_CONFIG_DIR, 'projects');
  const normalized = resolved.split(path.sep).join('/');
  return resolved.startsWith(base + path.sep) && normalized.includes('/subagents/workflows/');
}

function parseJsonlLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

function deriveLabel(result: unknown, prompt: string, agentId: string, agentType: string | null): string {
  if (result && typeof result === 'object') {
    const area = (result as Record<string, unknown>)['area'];
    if (typeof area === 'string' && area.trim()) return area.trim();
  }
  const firstLine = prompt.split('\n').map(line => line.trim()).find(Boolean);
  if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  if (agentType) return agentType;
  return `Agent ${agentId.slice(0, 8)}`;
}

function scanAgentFile(raw: string): AgentScan {
  let prompt = '';
  let model: string | null = null;
  let toolUseCount = 0;
  const blocks: WorkflowAgentBlock[] = [];
  const toolResults = new Map<string, string>();
  const seenToolUseIds = new Set<string>();

  for (const entry of parseJsonlLines(raw) as AgentJsonlEntry[]) {
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (typeof content === 'string') {
        if (!prompt) prompt = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
            const inner = b['content'];
            const text = typeof inner === 'string' ? inner : inner == null ? '' : JSON.stringify(inner) ?? '';
            toolResults.set(b['tool_use_id'] as string, text.slice(0, TOOL_RESULT_PREVIEW));
          } else if (!prompt && b['type'] === 'text' && typeof b['text'] === 'string') {
            prompt = b['text'] as string;
          }
        }
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      if (!model && entry.message?.model) model = entry.message.model;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          blocks.push({ type: 'text', text: b['text'] as string });
        } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
          blocks.push({ type: 'thinking', thinking: b['thinking'] as string });
        } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
          const id = b['id'] as string;
          if (seenToolUseIds.has(id)) continue;
          seenToolUseIds.add(id);
          toolUseCount++;
          blocks.push({
            type: 'tool_use',
            toolCall: {
              id,
              name: typeof b['name'] === 'string' ? (b['name'] as string) : 'tool',
              input: (b['input'] as Record<string, unknown>) ?? {},
              result: null,
            },
          });
        }
      }
    }
  }

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const result = toolResults.get(block.toolCall.id);
      if (result !== undefined) block.toolCall.result = result;
    }
  }

  return { prompt, model, toolUseCount, blocks };
}

/**
 * Read a workflow run's per-agent transcripts from disk. Agents are surfaced as soon as
 * they start — the journal's `started` entries and the per-agent `.meta.json` files are
 * written at launch, well before the per-agent `.jsonl` transcript (written atomically on
 * completion). A started-but-not-yet-finished agent is returned with `running: true` and an
 * empty transcript; once its `.jsonl` lands it is enriched with model, tool-use count,
 * blocks, and the structured result from the journal. Path-gated to the workflows directory.
 */
export async function readWorkflowTranscripts(transcriptDir: string): Promise<WorkflowAgentTranscript[]> {
  if (!isWithinWorkflowsDir(transcriptDir)) {
    throw new Error('Refusing to read transcripts outside the workflows directory');
  }

  const order: string[] = [];
  const resultByAgent = new Map<string, unknown>();
  const finishedByJournal = new Set<string>();
  try {
    const journalRaw = await fs.readFile(path.join(transcriptDir, 'journal.jsonl'), 'utf8');
    for (const entry of parseJsonlLines(journalRaw) as JournalEntry[]) {
      if (!entry.agentId) continue;
      if (!order.includes(entry.agentId)) order.push(entry.agentId);
      if (entry.type === 'result') {
        resultByAgent.set(entry.agentId, entry.result);
        finishedByJournal.add(entry.agentId);
      }
    }
  } catch {
    // No journal yet — fall back to the file listing alone.
  }

  const files = await fs.readdir(transcriptDir);
  const transcriptByAgent = new Map<string, string>();
  const metaByAgent = new Map<string, string | null>();
  for (const file of files) {
    if (file.startsWith('agent-') && file.endsWith('.meta.json')) {
      metaByAgent.set(file.slice('agent-'.length, -'.meta.json'.length), null);
    } else if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
      transcriptByAgent.set(file.slice('agent-'.length, -'.jsonl'.length), file);
    }
  }

  // Agent set = union of journal-started order, meta files, and transcript files, so an
  // agent appears the moment any of those exists (start) and stays through completion.
  for (const agentId of [...metaByAgent.keys(), ...transcriptByAgent.keys()]) {
    if (!order.includes(agentId)) order.push(agentId);
  }

  const agents: WorkflowAgentTranscript[] = [];
  for (const agentId of order) {
    const logFile = path.join(transcriptDir, `agent-${agentId}.jsonl`);
    let agentType: string | null = null;
    try {
      const metaRaw = await fs.readFile(path.join(transcriptDir, `agent-${agentId}.meta.json`), 'utf8');
      agentType = (JSON.parse(metaRaw) as AgentMeta).agentType ?? null;
    } catch {
      // No meta file — leave agentType null.
    }

    const transcriptFile = transcriptByAgent.get(agentId);
    let scan: AgentScan = { prompt: '', model: null, toolUseCount: 0, blocks: [] };
    if (transcriptFile) {
      try {
        scan = scanAgentFile(await fs.readFile(logFile, 'utf8'));
      } catch {
        // Transcript present but unreadable mid-write — keep the empty scan.
      }
    }

    // The per-agent .jsonl is created at agent start and appended during the run, so its
    // mere existence is NOT a completion signal. An agent is done only once the journal
    // records its `result` entry.
    const running = !finishedByJournal.has(agentId);
    const result = resultByAgent.get(agentId);
    agents.push({
      agentId,
      label: deriveLabel(result, scan.prompt, agentId, agentType),
      agentType,
      running,
      result: result ?? null,
      toolUseCount: scan.toolUseCount,
      model: scan.model,
      prompt: scan.prompt,
      logFile,
      blocks: scan.blocks,
    });
  }
  return agents;
}
