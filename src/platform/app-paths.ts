export type WorkerName = 'compass' | 'usageStats' | 'sentinel' | 'processLauncher' | 'memoryIntegrity' | 'sessionMetaIndex' | 'voiceExtract';

export interface AppPaths {
  readonly resourceRoot: string;
  readonly unpackedRoot: string;
  workerEntry(name: WorkerName): string;
  // the desktop's <userData>/remote, holding each remote host's session mirror; absent elsewhere
  readonly remoteMirrors?: string;
}
