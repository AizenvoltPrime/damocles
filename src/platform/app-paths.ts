export type WorkerName = 'compass' | 'usageStats' | 'sentinel';

export interface AppPaths {
  readonly resourceRoot: string;
  readonly unpackedRoot: string;
  workerEntry(name: WorkerName): string;
}
