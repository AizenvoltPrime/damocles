export type WorkerName = 'compass' | 'usageStats' | 'sentinel' | 'processLauncher' | 'memoryIntegrity' | 'sessionMetaIndex' | 'voiceExtract';

export interface AppPaths {
  readonly resourceRoot: string;
  readonly unpackedRoot: string;
  workerEntry(name: WorkerName): string;
}
