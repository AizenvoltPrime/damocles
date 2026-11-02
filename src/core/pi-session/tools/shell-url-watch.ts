import { installedPlatform } from '../../platform-host';

/** One output stream of a shell, its onData as the shell's, and its end once the shell exited. */
export interface WatchedOutput {
  readonly onData: (data: Buffer) => void;
  end(): void;
}

/** On a daemon's core, an agent shell's output stream also goes to the URL watch the daemon's port detection reads. */
export function withUrlWatch(onData: (data: Buffer) => void): WatchedOutput {
  const watch = installedPlatform()?.remote?.shellOutput();
  if (!watch) return { onData, end: () => undefined };
  return {
    onData: (data) => {
      onData(data);
      watch.write(data);
    },
    end: () => watch.end(),
  };
}
