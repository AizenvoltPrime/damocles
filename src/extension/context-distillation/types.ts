import * as path from 'path';
import * as os from 'os';

export type { ContextStrategy } from '../../shared/types/settings';

export const CONTEXT_DIR: string = path.join(os.homedir(), '.damocles', 'context');

export const DEFAULT_OBSERVER_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_TOKEN_BUDGET = 4000;
export const MAX_FAILED_RETRY_ENTRIES = 10;

export interface RerankingConfig {
  enabled: boolean;
  timeoutMs: number;
}

export const DEFAULT_RERANKING_CONFIG: RerankingConfig = {
  enabled: false,
  timeoutMs: 3000,
};

export interface DistillationConfig {
  enabled: boolean;
  observerModel: string;
  tokenBudget: number;
  reranking: RerankingConfig;
}

export type EntryType = 'file_change' | 'research' | 'command' | 'web' | 'summary' | 'discussion';
export type AnnotationStatus = 'pending' | 'annotating' | 'annotated' | 'failed' | 'skipped';

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
  confidence: number | null;
  semantic_group: string | null;
  annotation_status: AnnotationStatus;
}

export interface EntryLinkRow {
  id: number;
  source_entry_id: number;
  target_entry_id: number;
  link_type: string;
  created_at: number;
}

export interface SemanticGroupRow {
  id: number;
  session_id: string;
  label: string;
  description: string | null;
  first_prompt: number;
  last_prompt: number;
  entry_count: number;
}

export interface SubagentPersistState {
  agentId: string;
  model?: string;
  pendingToolResults: Array<{ toolUseId: string; content: string }>;
  blockPersistedForMessageId: string | null;
  pendingFinalResponse?: string;
  writeQueue: Promise<void>;
  initFailed?: boolean;
}

export type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;

export interface AnnotationResult {
  annotations: Array<{
    entry_id: number;
    description: string;
    tags: string;
    related_files: string[];
    low_relevance: boolean;
    confidence: number;
    semantic_group: string;
  }>;
  links: Array<{
    source_entry_id: number;
    target_entry_id: number;
    link_type: 'depends_on' | 'extends' | 'reverts' | 'related';
  }>;
  prompt_summary?: {
    summary: string;
    tags: string;
  };
}
