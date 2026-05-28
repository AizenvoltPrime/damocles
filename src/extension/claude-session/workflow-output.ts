import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Gate task output files to `<os.tmpdir()>/claude/<proj>/<session>/tasks/<id>.output`. The SDK
 * (imported in-process) builds these paths from the same `os.tmpdir()`, so a prefix check is
 * reliable. Mirrors `isWithinWorkflowsDir` — a `.output` suffix alone is not a security boundary.
 */
function isWithinTasksDir(file: string): boolean {
  const resolved = path.resolve(file);
  const base = path.resolve(os.tmpdir(), 'claude');
  const normalized = resolved.split(path.sep).join('/');
  return resolved.startsWith(base + path.sep) && normalized.includes('/tasks/') && resolved.endsWith('.output');
}

export interface WorkflowOutput {
  /** The workflow script's structured return value, stringified (JSON) when it is an object/array. */
  result: string;
  summary: string;
  agentCount: number;
}

/**
 * Read a completed workflow's task output file (written by the SDK at completion). It carries
 * the script's structured return value plus the summary and agent count — none of which the
 * lean live `system:task_notification` includes — so the panel can show the Result section
 * live instead of only after a history reload. Best-effort: returns null on any failure.
 */
export async function readWorkflowOutput(outputFile: string | null): Promise<WorkflowOutput | null> {
  if (!outputFile || !isWithinTasksDir(outputFile)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(outputFile, 'utf8')) as Record<string, unknown>;
    const rawResult = parsed['result'];
    const result =
      rawResult === undefined || rawResult === null
        ? ''
        : typeof rawResult === 'string'
          ? rawResult
          : JSON.stringify(rawResult);
    const summary = typeof parsed['summary'] === 'string' ? parsed['summary'] : '';
    const agentCount = typeof parsed['agentCount'] === 'number' ? parsed['agentCount'] : 0;
    if (!result && !summary && !agentCount) return null;
    return { result, summary, agentCount };
  } catch {
    return null;
  }
}
