export interface BackgroundTask {
  taskId: string;
  toolUseId: string | null;
  description: string;
  taskType: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startTime: number;
  endTime: number | null;
  outputFile: string | null;
  summary: string | null;
  progressSummary: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  lastToolName: string | null;
}
