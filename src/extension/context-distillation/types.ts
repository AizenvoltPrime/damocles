export type { ContextStrategy } from '../../shared/types/settings';

export interface DistillationConfig {
  enabled: boolean;
  observerModel: string;
}

export interface ContextDocument {
  content: string;
  lastUpdatedAt: number;
  turnCount: number;
}
