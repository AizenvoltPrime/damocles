import * as path from 'path';
import * as os from 'os';

export type { ContextStrategy } from '../../shared/types/settings';

export const CONTEXT_DIR: string = path.join(os.homedir(), '.damocles', 'context');

export const DEFAULT_OBSERVER_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_TOKEN_BUDGET = 4000;

export interface DistillationConfig {
  enabled: boolean;
  observerModel: string;
  tokenBudget: number;
}

export type EntryType = 'file_change' | 'research' | 'command' | 'web' | 'summary';

export interface ToolCallRecord {
  tool_name: string;
  input_summary: string;
}

export interface ContextEntryRow {
  id: number;
  session_id: string;
  prompt_index: number;
  file_path: string | null;
  entry_type: string;
  tool_calls: string;
  description: string | null;
  tags: string | null;
  related_files: string;
  low_relevance: number;
  created_at: number;
}
