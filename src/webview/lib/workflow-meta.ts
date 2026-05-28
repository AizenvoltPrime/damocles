import type { WorkflowPhase } from '@shared/types/workflows';
import { parseWorkflowLaunch } from '@shared/workflow-launch';

export interface ParsedWorkflowMeta {
  name: string;
  description: string;
  phases: WorkflowPhase[];
}

/**
 * Best-effort extraction of the `export const meta = {...}` literal a Workflow
 * script must declare. The meta is a pure literal by contract, so targeted
 * matching is sufficient; missing fields degrade to empty rather than throwing.
 */
export function parseWorkflowMeta(script: string): ParsedWorkflowMeta {
  const name = script.match(/\bname:\s*(['"])((?:\\.|(?!\1).)*)\1/)?.[2] ?? '';
  const description = script.match(/\bdescription:\s*(['"])((?:\\.|(?!\1).)*)\1/)?.[2] ?? '';

  const phases: WorkflowPhase[] = [];
  const phasesBlock = script.match(/phases:\s*\[([\s\S]*?)\]/)?.[1];
  if (phasesBlock) {
    const phaseRe = /\{[^}]*?title:\s*(['"])((?:\\.|(?!\1).)*)\1(?:[^}]*?detail:\s*(['"])((?:\\.|(?!\3).)*)\3)?[^}]*?\}/g;
    let match: RegExpExecArray | null;
    while ((match = phaseRe.exec(phasesBlock)) !== null) {
      phases.push({ title: match[2], detail: match[4] ?? null });
    }
  }

  return { name, description, phases };
}

/** Extract the "Transcript dir: <path>" line from a Workflow tool's launch result. */
export function parseTranscriptDir(result: string): string | null {
  return parseWorkflowLaunch(result).transcriptDir;
}

/** Extract the "Task ID: <id>" from a Workflow tool's launch result (used to stop a running run). */
export function parseTaskId(result: string): string | null {
  return parseWorkflowLaunch(result).taskId;
}
