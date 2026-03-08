export interface LoopJob {
  taskId: string;
  prompt: string;
  cron: string;
  intervalLabel: string;
  createdAt: number;
  status: 'active' | 'cancelling' | 'stopped' | 'expired';
  recurring?: boolean;
}
