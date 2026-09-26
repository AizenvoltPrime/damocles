export interface BackgroundTask {
  taskId: string;
  toolUseId: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
}
